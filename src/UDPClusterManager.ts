/*!
 * UDP message listener for cluster managing
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import { ClusterManager, ICluster } from './ClusterManager';
import { IServerInput } from './IMessageQueue';
import { Worker } from 'worker_threads';
import { join } from 'path';

/** Shape of a message posted from the UDP worker thread */
interface WorkerMessage {
    type?: string;
    server?: unknown;
}

/** Minimal socket surface destroySocket() interacts with */
interface DisposableSocket {
    removeAllListeners?: () => void;
    close?: (callback?: () => void) => void;
    unref?: () => void;
}

export interface UDPClusterManagerOptions {
    /**
     * Message queue broadcast port
     *
     * @default 63000
     * @type {number}
     */
    port: number;

    /**
     * Message queue broadcast address
     *
     * @type {number}
     */
    address: string;

    /**
     * Message-queue-limited broadcast address
     *
     * @default "255.255.255.255"
     * @type {string}
     */
    limitedAddress?: string;

    /**
     * Message queue alive timeout correction. Used to correct waiting time to
     * check if the server is alive
     *
     * @default 5000
     * @type {number}
     */
    aliveTimeoutCorrection: number;

    /**
     * Message queue alive-server check flag. If set to false, the server will
     * not be checked for liveness on each broadcast message with a timeout.
     * Can be specified by the environment variable if the given option is not
     * bypassed: IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK
     *
     * @default true
     * @type {boolean}
     */
    useAliveCheck: boolean;
}

const IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK = !!+(
    process.env.IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK || 1
);

export const DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS: UDPClusterManagerOptions = {
    port: 63000,
    address: '255.255.255.255',
    aliveTimeoutCorrection: 5000,
    useAliveCheck: IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK,
};

export class UDPClusterManager extends ClusterManager {
    private static workers: Record<string, Worker> = {};

    /** Number of manager instances sharing each worker (by address:port) */
    private static workerRefs: Record<string, number> = {};

    public static sockets: Record<string, DisposableSocket> = {};

    /** True once process-level signal handlers have been registered */
    private static signalsBound: boolean = false;

    private readonly options: UDPClusterManagerOptions;
    private workerKey!: string;
    private worker!: Worker;

    constructor(options?: Partial<UDPClusterManagerOptions>) {
        super();

        this.options = {
            ...DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS,
            ...options,
        };

        this.startWorkerListener();

        UDPClusterManager.bindSignals();
    }

    /**
     * Registers process-level shutdown handlers exactly once per process,
     * so multiple manager instances do not accumulate duplicate listeners.
     *
     * @access private
     */
    private static bindSignals(): void {
        if (UDPClusterManager.signalsBound) {
            return;
        }

        UDPClusterManager.signalsBound = true;

        process.on('SIGTERM', UDPClusterManager.free);
        process.on('SIGINT', UDPClusterManager.free);
        process.on('SIGABRT', UDPClusterManager.free);
    }

    private static async free(): Promise<void> {
        const workerKeys = Object.keys(UDPClusterManager.workers);

        await Promise.all(
            workerKeys.map(workerKey =>
                UDPClusterManager.destroyWorker(
                    workerKey,
                    UDPClusterManager.workers[workerKey],
                ),
            ),
        );
    }

    private startWorkerListener(): void {
        this.workerKey = `${this.options.address}:${this.options.port}`;
        UDPClusterManager.workerRefs[this.workerKey] =
            (UDPClusterManager.workerRefs[this.workerKey] || 0) + 1;

        if (UDPClusterManager.workers[this.workerKey]) {
            this.worker = UDPClusterManager.workers[this.workerKey];

            return;
        }

        this.worker = new Worker(join(__dirname, './UDPWorker.js'), {
            workerData: this.options,
        });
        this.worker.on('message', (message: WorkerMessage) => {
            void this.handleWorkerMessage(message);
        });

        UDPClusterManager.workers[this.workerKey] = this.worker;
    }

    /**
     * Applies a worker cluster message (add/remove) to every registered
     * cluster. Errors from cluster callbacks are contained here, so the
     * worker message listener can never raise an unhandled rejection.
     *
     * @access private
     * @param {WorkerMessage} message
     * @returns {Promise<void>}
     */
    private async handleWorkerMessage(message: WorkerMessage): Promise<void> {
        const [className, method] = String(message.type ?? '').split(':');

        if (className !== 'cluster') {
            return;
        }

        const action = method as keyof ICluster;

        try {
            await this.anyCluster(cluster => {
                const server = message.server as IServerInput;

                if (action === 'add' && cluster.find(server)) {
                    return;
                }

                const handler = cluster[action] as
                    | ((server: IServerInput) => unknown)
                    | undefined;

                handler?.(server);
            });
        } catch {
            // a failing cluster callback must not crash the listener
        }
    }

    public async destroy(): Promise<void> {
        const refs = UDPClusterManager.workerRefs[this.workerKey] ?? 0;

        if (refs > 1) {
            // the worker is still shared with other manager instances on
            // the same address:port — just release this reference
            UDPClusterManager.workerRefs[this.workerKey] = refs - 1;

            return;
        }

        delete UDPClusterManager.workerRefs[this.workerKey];
        await UDPClusterManager.destroyWorker(this.workerKey, this.worker);
    }

    public static async destroySocket(
        key: string,
        socket?: DisposableSocket,
    ): Promise<void> {
        if (!socket) {
            return;
        }

        if (typeof socket.removeAllListeners === 'function') {
            socket.removeAllListeners();
        }

        const close = socket.close;

        if (typeof close !== 'function') {
            return;
        }

        await new Promise<void>(resolve => {
            close.call(socket, () => {
                if (typeof socket.unref === 'function') {
                    socket.unref();
                }
                if (
                    UDPClusterManager.sockets &&
                    key in UDPClusterManager.sockets
                ) {
                    delete UDPClusterManager.sockets[key];
                }
                resolve();
            });
        });
    }

    private static async destroyWorker(
        workerKey: string,
        worker?: Worker,
    ): Promise<void> {
        if (!worker) {
            return;
        }

        return new Promise<void>(resolve => {
            const timeout = setTimeout(() => {
                worker.terminate();
                resolve();
            }, 5000);

            worker.postMessage({ type: 'stop' });
            worker.once('message', message => {
                if (message.type === 'stopped') {
                    clearTimeout(timeout);
                    worker.terminate();

                    delete UDPClusterManager.workers[workerKey];

                    resolve();
                }
            });
        });
    }
}
