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
import { Worker } from 'worker_threads';
import * as path from 'path';

process.setMaxListeners(10000);

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
     * Message queue limited broadcast address
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
}

export const DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS: UDPClusterManagerOptions = {
    port: 63000,
    address: '255.255.255.255',
    aliveTimeoutCorrection: 5000,
};

export class UDPClusterManager extends ClusterManager {
    private static workers: Record<string, Worker> = {};
    public static sockets: Record<string, any> = {};
    private readonly options: UDPClusterManagerOptions;
    private workerKey: string;
    private worker: Worker;

    constructor(options?: Partial<UDPClusterManagerOptions>) {
        super();

        this.options = {
            ...DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS,
            ...options || {},
        };

        this.startWorkerListener();

        process.on('SIGTERM', UDPClusterManager.free);
        process.on('SIGINT', UDPClusterManager.free);
        process.on('SIGABRT', UDPClusterManager.free);
    }

    private static async free(): Promise<void> {
        const workerKeys = Object.keys(UDPClusterManager.workers);

        await Promise.all(workerKeys.map(
            workerKey => UDPClusterManager.destroyWorker(
                workerKey,
                UDPClusterManager.workers[workerKey],
            )),
        );
    }

    private startWorkerListener(): void {
        this.workerKey = `${ this.options.address }:${ this.options.port }`;

        if (UDPClusterManager.workers[this.workerKey]) {
            this.worker = UDPClusterManager.workers[this.workerKey];

            return;
        }

        this.worker = new Worker(path.join(__dirname, './UDPWorker.js'), {
            workerData: this.options,
        });
        this.worker.on('message', message => {
            const [className, method] = message.type?.split(':');

            if (className !== 'cluster') {
                return;
            }

            return this.anyCluster(cluster => {
                if (method === 'add') {
                    try {
                        const existing = typeof (cluster as any).find === 'function'
                            ? (cluster as any).find(message.server, true)
                            : undefined;
                        if (existing) {
                            return;
                        }
                    } catch {/* ignore */}
                }

                const clusterMethod = (cluster as any)[method as keyof ICluster];

                if (!clusterMethod) {
                    return;
                }

                clusterMethod(message.server);
            });
        });

        UDPClusterManager.workers[this.workerKey] = this.worker;
    }

    public async destroy(): Promise<void> {
        await UDPClusterManager.destroyWorker(this.workerKey, this.worker);
    }

    public static async destroySocket(key: string, socket?: any): Promise<void> {
        if (!socket) {
            return;
        }

        try {
            if (typeof socket.removeAllListeners === 'function') {
                socket.removeAllListeners();
            }
        } catch (e) {
            throw e;
        }

        if (typeof socket.close !== 'function') {
            return;
        }

        await new Promise<void>((resolve) => {
            socket.close(() => {
                if (typeof socket.unref === 'function') {
                    socket.unref();
                }
                if (UDPClusterManager.sockets && key in UDPClusterManager.sockets) {
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
            worker.once('message', (message) => {
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
