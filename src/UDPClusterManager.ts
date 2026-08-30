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
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ClusterManager, type ICluster } from './ClusterManager.js';
import { type ILogger, type IServerInput } from './IMessageQueue.js';

/** Shape of a message posted from the UDP worker thread */
interface WorkerMessage {
    type?: string;
    server?: unknown;
    error?: string;
}

/**
 * Configuration for {@link UDPClusterManager}.
 *
 * Pass any subset to the constructor; unspecified values come from
 * {@link DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS}.
 *
 * @remarks
 * All the broadcast-related values — `address`, `port`, `limitedAddress`,
 * `aliveTimeoutCorrection` and `useAliveCheck` — together identify the shared
 * broadcast worker, so two managers agreeing on all of them share one socket and
 * one worker thread. `logger` and `handleSignals` are not part of that identity.
 */
export interface UDPClusterManagerOptions {
    /**
     * UDP port the manager listens on for cluster announcements.
     *
     * @defaultValue 63000
     *
     * @remarks
     * The socket is opened with address and port reuse, so several processes on
     * one host can listen simultaneously. The port is part of the shared-worker
     * identity: managers using different ports each get their own socket and
     * worker thread. There is no separate send port — this manager only listens.
     */
    port: number;

    /**
     * Broadcast address the cluster announces on.
     *
     * @defaultValue "255.255.255.255"
     *
     * @remarks
     * The worker binds the local IPv4 interface whose address matches this value
     * with its `.255` octets removed — so `10.0.1.255` selects an interface in
     * `10.0.1.x` — and falls back to all interfaces when nothing matches, which is
     * what happens for the default value.
     */
    address: string;

    /**
     * Limited-broadcast address marker. No default: when unset, the worker tries
     * to bind the local interface matching {@link UDPClusterManagerOptions.address}.
     *
     * @remarks
     * This is only ever compared against `address`; it is never itself used as a
     * bind or destination address. Setting it to the same value as `address` makes
     * the worker bind all interfaces (`0.0.0.0`) instead of selecting one.
     */
    limitedAddress?: string;

    /**
     * Grace period in milliseconds added to the liveness timeout each server
     * advertises in its broadcast.
     *
     * @defaultValue 5000
     *
     * @remarks
     * A server is dropped from the cluster when no new announcement arrives within
     * its advertised timeout plus this correction. Raise it on lossy networks to
     * avoid dropping healthy servers. It has no effect when
     * {@link UDPClusterManagerOptions.useAliveCheck} is disabled.
     */
    aliveTimeoutCorrection: number;

    /**
     * Whether announced servers are expired when they stop broadcasting.
     *
     * @defaultValue true
     *
     * @remarks
     * When disabled, a server is removed only on an explicit `down` announcement —
     * so a host that dies silently is never removed and keeps receiving
     * round-robin sends.
     *
     * The default can be overridden with the
     * `IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK` environment variable, which is read as
     * a number when the module loads: use `1` to enable and `0` to disable.
     * Any non-numeric value — including the word `true` — is read as disabled.
     */
    useAliveCheck: boolean;

    /**
     * Enable process signal handling (SIGTERM, SIGINT, SIGABRT) by the
     * manager. When enabled, the manager stops its UDP workers on these
     * signals and then re-raises the signal, so the process terminates
     * through the default signal behavior. Disable if the host application
     * manages its own shutdown sequence.
     *
     * @defaultValue true
     *
     * @remarks
     * The handlers are installed once per process, by the first manager created
     * with this enabled, and on a signal they stop every UDP worker in the
     * process — including those of managers created with this option disabled. So
     * disabling it only means this instance does not install the handlers; it does
     * not exempt its worker from a shutdown another instance triggers.
     *
     * Once installed, the handlers remain for the lifetime of the process, even
     * after every manager has been destroyed.
     */
    handleSignals: boolean;

    /**
     * Logger used for worker supervision messages
     *
     * @defaultValue console
     */
    logger: ILogger;
}

/**
 * The options actually handed to the UDP worker thread: everything except the
 * logger, which is not structured-cloneable, and the signal-handling flag, which
 * the main thread owns.
 *
 * @remarks
 * These are precisely the settings the worker's behaviour depends on, which is
 * why the same fields form the shared-worker identity — managers agreeing on all
 * of them can share one worker thread.
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

/**
 * Default options applied to every {@link UDPClusterManager} unless overridden:
 * broadcast address `255.255.255.255` on port `63000`, a 5000 ms alive-timeout
 * correction, liveness checking enabled, process signal handling enabled, and
 * `console` as the logger.
 *
 * @remarks
 * No `limitedAddress` is set by default. The liveness default is read from
 * `IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK` once when the module is loaded, so that
 * variable must be set before the module is first imported.
 */
export const DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS: UDPClusterManagerOptions = {
    port: 63000,
    address: '255.255.255.255',
    aliveTimeoutCorrection: 5000,
    useAliveCheck: IMQ_UDP_CLUSTER_MANAGER_ALIVE_CHECK,
    handleSignals: true,
    logger: console,
};

/**
 * Cluster manager that discovers redis cluster members from UDP broadcast
 * announcements. Supply instances through {@link IMQOptions.clusterManagers}.
 *
 * @remarks
 * It runs a supervised worker thread holding the broadcast socket and applies
 * each announcement to every registered cluster, skipping servers that are
 * already known. Managers created with the same broadcast settings share one
 * socket and worker thread, reference-counted so the worker lives until the last
 * of them is destroyed; the `logger` and `handleSignals` options are not part of
 * that identity. If the worker dies unexpectedly it is logged and re-spawned
 * after one second with all live managers re-attached, so membership tracking
 * resumes on its own.
 *
 * Announcements are not filtered by queue name: every cluster registered with
 * a manager listening on a given address and port receives every server announced
 * there. Isolate unrelated services by giving them distinct broadcast addresses
 * or ports.
 *
 * Wire format — each announcement is one UDP datagram containing five
 * tab-separated fields: queue name, unique server id, `up` or `down`,
 * `host:port`, and the liveness timeout in seconds. Datagrams with a missing
 * field, a port outside 1-65535, or a negative timeout are ignored. An `up`
 * announcement adds the server and refreshes its liveness deadline; a `down`
 * announcement removes it immediately.
 */
export class UDPClusterManager extends ClusterManager {
    /**
     * The broadcast worker thread per worker key.
     *
     * @remarks
     * Shared process-wide: managers configured alike use one worker between
     * them rather than each binding its own socket to the same port.
     */
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

    /** This manager's effective options, defaults already applied */
    private readonly options: UDPClusterManagerOptions;
    /**
     * Key identifying the worker this manager shares, derived from every option
     * that affects what the worker listens to — so managers differing in any of
     * them get workers of their own.
     */
    private workerKey!: string;
    /** The worker thread this manager is attached to */
    private worker!: Worker;
    /** Set by {@link UDPClusterManager.destroy}, to keep it idempotent */
    private destroyed: boolean = false;

    /**
     * Creates the manager and starts listening for broadcasts immediately,
     * joining an existing worker when another manager already uses the same
     * broadcast settings.
     *
     * @param options - partial options merged over
     *        {@link DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS}
     *
     * @remarks
     * The merge is a plain shallow spread, so passing an explicit `undefined`
     * overrides a default rather than falling back to it — pass only the
     * properties you mean to change.
     *
     * Broadcast listening begins before any cluster is registered, so register
     * yours with {@link ClusterManager.init} right away: announcements that arrive
     * in the meantime are discarded. When
     * {@link UDPClusterManagerOptions.handleSignals} is enabled, this also
     * installs process-wide signal handlers.
     */
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
     * @param options -
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
     * @param signal -
     */
    private static async freeAndRaise(signal: NodeJS.Signals): Promise<void> {
        await UDPClusterManager.free();
        // the once-registered handler is already removed at this point, so
        // re-raising hits the default handler and terminates the process
        process.kill(process.pid, signal);
    }

    /**
     * Tears down every shared worker in this process, on the way out.
     *
     * @remarks
     * Called from the process signal handlers, so it works across all managers
     * rather than just one, and marks the process as shutting down first so a
     * worker exiting is not mistaken for a crash and respawned.
     */
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
     */
    private spawnWorker(): Worker {
        const workerData: UDPWorkerOptions = {
            port: this.options.port,
            address: this.options.address,
            limitedAddress: this.options.limitedAddress,
            aliveTimeoutCorrection: this.options.aliveTimeoutCorrection,
            useAliveCheck: this.options.useAliveCheck,
        };
        const worker = new Worker(join(import.meta.dirname, './UDPWorker.js'), {
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
     * @param workerKey -
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
     * @param message -
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

    /**
     * Stops this manager and releases its share of the broadcast worker.
     *
     * @remarks
     * Safe to call more than once. The shared worker is only shut down when this
     * is the last manager using it — otherwise the call just releases this
     * manager's reference and the worker keeps running for the others. Shutdown
     * asks the worker to close its socket and waits up to five seconds for
     * confirmation before terminating the thread.
     *
     * Process signal handlers installed by this manager are not removed, and
     * registered clusters are not cleared — use {@link ClusterManager.remove} for
     * that, which itself calls this method once the last cluster is gone.
     */
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

    /**
     * Terminates one shared worker and forgets it.
     *
     * @param workerKey - the key it is registered under
     * @param worker - the worker itself; absent when it is already gone, in
     *        which case this does nothing
     *
     * @remarks
     * The worker is marked as intentionally stopped before termination, because
     * `terminate()` makes the `exit` event fire with a non-zero code that would
     * otherwise read as a crash and trigger a respawn.
     */
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
