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
import { ILogger, IServerInput } from './IMessageQueue';
import { Worker } from 'worker_threads';
import { join } from 'path';

/** Shape of a message posted from the UDP worker thread */
interface WorkerMessage {
    type?: string;
    server?: unknown;
    error?: string;
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

    /**
     * Enable process signal handling (SIGTERM, SIGINT, SIGABRT) by the
     * manager. When enabled, the manager stops its UDP workers on these
     * signals and then re-raises the signal, so the process terminates
     * through the default signal behavior. Disable if the host application
     * manages its own shutdown sequence.
     *
     * @default true
     * @type {boolean}
     */
    handleSignals: boolean;

    /**
     * Logger used for worker supervision messages
     *
     * @default console
     * @type {ILogger}
     */
    logger: ILogger;
}

/**
 * Subset of the manager options handed over to the UDP worker thread. Only
 * structured-cloneable values may appear here (no logger).
 */
export type UDPWorkerOptions = Omit<
    UDPClusterManagerOptions,
    'logger' | 'handleSignals'
>;

const IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK = !!+(
    process.env.IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK || 1
);

/** Delay (ms) before an unexpectedly dead worker is re-spawned */
const WORKER_RESPAWN_DELAY = 1000;

export const DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS: UDPClusterManagerOptions = {
    port: 63000,
    address: '255.255.255.255',
    aliveTimeoutCorrection: 5000,
    useAliveCheck: IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK,
    handleSignals: true,
    logger: console,
};

export class UDPClusterManager extends ClusterManager {
    private static workers: Record<string, Worker> = {};

    /** Number of manager instances sharing each worker (by worker key) */
    private static workerRefs: Record<string, number> = {};

    /** Live manager instances per worker key, used for re-attachment */
    private static instances: Record<string, Set<UDPClusterManager>> = {};

    /** True once process-level signal handlers have been registered */
    private static signalsBound: boolean = false;

    /** True while the process is shutting down via a signal */
    private static shuttingDown: boolean = false;

    /**
     * Workers we terminated on purpose. worker.terminate() makes the 'exit'
     * event fire with a non-zero code, which would otherwise be mistaken for
     * a crash and trigger a spurious "exited unexpectedly" warning and respawn.
     */
    private static intentionallyStopped: WeakSet<Worker> = new WeakSet();

    private readonly options: UDPClusterManagerOptions;
    private workerKey!: string;
    private worker!: Worker;
    private destroyed: boolean = false;

    constructor(options?: Partial<UDPClusterManagerOptions>) {
        super();

        this.options = {
            ...DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS,
            ...options,
        };

        this.startWorkerListener();

        if (this.options.handleSignals) {
            UDPClusterManager.bindSignals();
        }
    }

    private get logger(): ILogger {
        return this.options.logger;
    }

    /**
     * Builds the shared-worker key from every option the worker thread
     * depends on, so managers configured differently never silently share
     * a worker built from another manager's options.
     *
     * @param {UDPClusterManagerOptions} options
     * @returns {string}
     */
    private static workerKeyFor(options: UDPClusterManagerOptions): string {
        return [
            options.address,
            options.port,
            options.limitedAddress ?? '',
            options.aliveTimeoutCorrection,
            options.useAliveCheck,
        ].join('|');
    }

    /**
     * Registers process-level shutdown handlers exactly once per process.
     * After stopping the workers, the original signal is re-raised, so the
     * default termination behavior (which registering a handler cancels)
     * still applies, and the process exits.
     */
    private static bindSignals(): void {
        if (UDPClusterManager.signalsBound) {
            return;
        }

        UDPClusterManager.signalsBound = true;

        const onSignal = (signal: NodeJS.Signals): void => {
            void UDPClusterManager.freeAndRaise(signal);
        };

        process.once('SIGTERM', onSignal);
        process.once('SIGINT', onSignal);
        process.once('SIGABRT', onSignal);
    }

    /**
     * Stops all workers and re-raises the given signal, so the process
     * terminates through the default signal behavior.
     *
     * @param {NodeJS.Signals} signal
     * @returns {Promise<void>}
     */
    private static async freeAndRaise(signal: NodeJS.Signals): Promise<void> {
        await UDPClusterManager.free();
        // the once-registered handler is already removed at this point, so
        // re-raising hits the default handler and terminates the process
        process.kill(process.pid, signal);
    }

    private static async free(): Promise<void> {
        UDPClusterManager.shuttingDown = true;

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

    /**
     * Registers this instance on the (possibly shared) worker for its
     * options. Every instance attaches its own message listener, so all
     * managers sharing a worker receive cluster updates.
     */
    private startWorkerListener(): void {
        this.workerKey = UDPClusterManager.workerKeyFor(this.options);

        UDPClusterManager.workerRefs[this.workerKey] =
            (UDPClusterManager.workerRefs[this.workerKey] || 0) + 1;
        (UDPClusterManager.instances[this.workerKey] ??= new Set()).add(this);

        this.worker =
            UDPClusterManager.workers[this.workerKey] || this.spawnWorker();
        this.worker.on('message', this.onWorkerMessage);
    }

    /**
     * Spawns and supervises a UDP worker for this manager's options. On an
     * unexpected worker death the worker is dropped from the registry, and
     * a re-spawn is scheduled while live manager instances remain.
     *
     * @returns {Worker}
     */
    private spawnWorker(): Worker {
        const workerData: UDPWorkerOptions = {
            port: this.options.port,
            address: this.options.address,
            limitedAddress: this.options.limitedAddress,
            aliveTimeoutCorrection: this.options.aliveTimeoutCorrection,
            useAliveCheck: this.options.useAliveCheck,
        };
        const worker = new Worker(join(__dirname, './UDPWorker.js'), {
            workerData,
        });
        const workerKey = this.workerKey;

        // many manager instances may listen on one shared worker
        worker.setMaxListeners(0);

        worker.on('error', err => {
            this.logger.error(
                `UDPClusterManager: worker ${workerKey} error:`,
                err,
            );
        });
        worker.on('exit', code => {
            if (UDPClusterManager.workers[workerKey] === worker) {
                delete UDPClusterManager.workers[workerKey];
            }

            // an exit we caused via terminate() (graceful destroy/shutdown)
            // is expected, even though terminate() reports a non-zero code
            if (UDPClusterManager.intentionallyStopped.has(worker)) {
                UDPClusterManager.intentionallyStopped.delete(worker);

                return;
            }

            if (code !== 0 && !UDPClusterManager.shuttingDown) {
                this.logger.warn(
                    `UDPClusterManager: worker ${workerKey} exited ` +
                        `unexpectedly (code ${code})`,
                );
                UDPClusterManager.respawn(workerKey);
            }
        });

        UDPClusterManager.workers[this.workerKey] = worker;

        return worker;
    }

    /**
     * Schedules a replacement worker for the given key and re-attaches all
     * live manager instances to it, so cluster membership does not silently
     * freeze after a worker crash.
     *
     * @param {string} workerKey
     */
    private static respawn(workerKey: string): void {
        const instances = UDPClusterManager.instances[workerKey];

        if (UDPClusterManager.shuttingDown || !instances?.size) {
            return;
        }

        const timer = setTimeout(() => {
            const [first] = instances;

            if (
                !first ||
                UDPClusterManager.shuttingDown ||
                UDPClusterManager.workers[workerKey]
            ) {
                return;
            }

            const worker = first.spawnWorker();

            for (const instance of instances) {
                instance.worker = worker;
                worker.on('message', instance.onWorkerMessage);
            }
        }, WORKER_RESPAWN_DELAY);

        timer.unref();
    }

    /**
     * Bound per-instance worker message listener, kept as a field so it can
     * be detached from the shared worker when this instance is destroyed.
     */
    private readonly onWorkerMessage = (message: WorkerMessage): void => {
        void this.handleWorkerMessage(message);
    };

    /**
     * Applies a worker cluster message (add/remove) to every registered
     * cluster. Cluster callback errors are contained per cluster, so the
     * worker message listener can never raise an unhandled rejection.
     *
     * @param {WorkerMessage} message
     * @returns {Promise<void>}
     */
    private async handleWorkerMessage(message: WorkerMessage): Promise<void> {
        if (message.type === 'error') {
            this.logger.warn(
                `UDPClusterManager: worker socket error: ${message.error}`,
            );

            return;
        }

        const [className, method] = String(message.type ?? '').split(':');

        if (className !== 'cluster') {
            return;
        }

        const action = method as keyof ICluster;

        await this.forEachCluster(cluster => {
            const server = message.server as IServerInput;

            if (action === 'add' && cluster.find(server)) {
                return;
            }

            const handler = cluster[action] as
                | ((server: IServerInput) => unknown)
                | undefined;

            handler?.(server);
        });
    }

    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.worker.off('message', this.onWorkerMessage);
        UDPClusterManager.instances[this.workerKey]?.delete(this);

        const refs = UDPClusterManager.workerRefs[this.workerKey] ?? 0;

        if (refs > 1) {
            // the worker is still shared with other manager instances
            // configured the same way — just release this reference
            UDPClusterManager.workerRefs[this.workerKey] = refs - 1;

            return;
        }

        delete UDPClusterManager.workerRefs[this.workerKey];
        delete UDPClusterManager.instances[this.workerKey];
        await UDPClusterManager.destroyWorker(this.workerKey, this.worker);
    }

    private static async destroyWorker(
        workerKey: string,
        worker?: Worker,
    ): Promise<void> {
        if (!worker) {
            return;
        }

        return new Promise<void>(resolve => {
            const finish = (): void => {
                worker.off('message', onMessage);
                clearTimeout(timeout);
                // mark before terminating: the resulting non-zero exit is
                // intentional and must not be treated as a crash
                UDPClusterManager.intentionallyStopped.add(worker);
                worker.terminate();

                if (UDPClusterManager.workers[workerKey] === worker) {
                    delete UDPClusterManager.workers[workerKey];
                }

                resolve();
            };
            // a persistent, filtering listener: unrelated cluster messages
            // arriving between the stop request and the stop confirmation
            // must not consume the wait
            const onMessage = (message: WorkerMessage): void => {
                if (message.type === 'stopped') {
                    finish();
                }
            };
            const timeout = setTimeout(finish, 5000);

            worker.on('message', onMessage);
            worker.postMessage({ type: 'stop' });
        });
    }
}
