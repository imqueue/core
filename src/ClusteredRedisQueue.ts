/*!
 * Clustered messaging queue over Redis implementation
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
import { EventEmitter } from 'node:events';
import { type InitializedCluster } from './ClusterManager.js';
import { buildOptions, copyEventEmitter, errorCode } from './helpers/index.js';
import {
    DEFAULT_IMQ_OPTIONS,
    type EventMap,
    type ILogger,
    type IMessageQueue,
    type IMessageQueueConnection,
    IMQMode,
    type IMQOptions,
    type IServerInput,
    type JsonObject,
    RedisQueue,
} from './index.js';

/**
 * Time (ms) send() waits for the first cluster server to become available
 * before rejecting, when the cluster is still empty. Configurable via the
 * IMQ_SEND_INIT_TIMEOUT environment variable, defaults to 30,000.
 */
const SEND_INIT_TIMEOUT = +(process.env.IMQ_SEND_INIT_TIMEOUT || 0) || 30000;

/**
 * Delay (ms) before the first retry of a joining host's subscription catch-up,
 * doubling up to {@link SYNC_RETRY_MAX_DELAY}. Mirrors the connection layer's
 * own reconnect policy, which this retry has to outlive: the socket may take
 * several attempts to come back, and the handlers have to go on afterwards.
 */
const SYNC_RETRY_BASE_DELAY = 1000;

/** Longest delay (ms) between subscription catch-up retries. */
const SYNC_RETRY_MAX_DELAY = 30000;

/**
 * A server registered in a {@link ClusteredRedisQueue}: its address, plus the
 * {@link RedisQueue} instance serving that host.
 *
 * Returned by {@link ClusteredRedisQueue.addServer} so callers can address or
 * inspect one specific host of the cluster.
 */
export interface ClusterServer extends IMessageQueueConnection {
    /**
     * Queue instance created for this host. Present once the server has been
     * registered; the queue may still be starting.
     *
     * @remarks
     * Exposed to inspect or address one specific host. Subscribing through it
     * directly is safe only on the channel the cluster itself uses: a queue
     * accepts one channel, so a direct subscription to another name makes every
     * later cluster registration on that host fail. `unsubscribe()` and
     * `destroy()` on it are not
     * supported: the cluster tracks how many of its own registrations a host
     * has taken, and it cannot see a handler removed behind its back, so a
     * registration made afterwards would be installed while an earlier one
     * stayed missing. Use {@link ClusteredRedisQueue.unsubscribe} and
     * {@link ClusteredRedisQueue.removeServer} instead.
     */
    imq?: RedisQueue;
}

interface ClusterState {
    started: boolean;
    channel: string | null;
    handlers: Array<(data: JsonObject) => void>;
}

/**
 * Serialises subscription changes for one host.
 */
interface HostProgress {
    /** Repaired tail; callers receive the original operation's rejection. */
    chain: Promise<void>;
    /** Registrations successfully installed by this cluster since teardown. */
    installed: number;
    /** Pending catch-up retry, so teardown can cancel it. */
    retryTimer?: ReturnType<typeof setTimeout>;
    /** Consecutive failed catch-up attempts, for the backoff. */
    retryAttempts: number;
}

/**
 * Scales a single logical queue horizontally across several redis instances.
 * This is what {@link IMQ.create} returns when {@link IMQOptions.cluster} or
 * {@link IMQOptions.clusterManagers} is supplied.
 *
 * @remarks
 * Distribution is asymmetric, and this is the most important thing to know about
 * the class: {@link ClusteredRedisQueue.send} routes each message to exactly
 * one server, chosen by health-aware round-robin that skips instances whose
 * writer connection is not ready. Every other operation — `start`, `stop`,
 * `clear`, `destroy`, `publish`, `subscribe`, `unsubscribe` and `queueLength` —
 * fans out to every server.
 *
 * Fan-out normally uses `Promise.all`, with no rollback on failure. Destroy
 * attempts every cleanup task and reports failures together in an AggregateError.
 *
 * The class only `implements` the `EventEmitter` interface rather than extending
 * it, so `instanceof EventEmitter` is false and every emitter method is a
 * delegating shim — see the individual methods for their fan-out semantics, and
 * note in particular that {@link ClusteredRedisQueue.once} is per-server.
 */
export class ClusteredRedisQueue
    implements IMessageQueue, EventEmitter<EventMap>
{
    /**
     * Logger used for this cluster's own messages, defaulting to
     * {@link IMQOptions.logger} or `console`.
     *
     * @remarks
     * Replacing it affects cluster-level logging only — each per-host queue keeps
     * the logger it was constructed with.
     */
    public logger: ILogger;

    /**
     * RedisQueue instances collection
     */
    private imqs: RedisQueue[] = [];

    /**
     * Options associated with this queue instance
     */
    private readonly options: IMQOptions;

    /**
     * Part of options without cluster definitions - which are generic for
     * RedisQueue instances
     */
    private readonly mqOptions: IMQOptions;

    /**
     * Cluster servers option definitions
     */
    private servers: ClusterServer[] = [];

    /**
     * Current queue index (round-robin)
     */
    private currentQueue: number = 0;

    /**
     * Time (ms) send() waits for the first server when the cluster is empty
     */
    private readonly sendInitTimeout: number = SEND_INIT_TIMEOUT;

    /**
     * Total length of RedisQueue instances
     */
    private imqLength: number = 0;

    /**
     * True while round-robin has no available instance left to pick, so that
     * the condition is reported on entry only and not on every send
     */
    private noneAvailable: boolean = false;

    /**
     * True while a publish had no server to publish to, so that the condition
     * is reported on entry only and not on every publish
     */
    private noPublishTargets: boolean = false;

    /**
     * Template EventEmitter instance used to replicate queue EventEmitters when
     * dynamically modifying the cluster
     */
    private readonly templateEmitter: EventEmitter;

    /**
     * Cluster EventEmitter instance used to notify about changes of
     * cluster servers
     */
    private readonly clusterEmitter: EventEmitter;

    /**
     * What has been done to this queue so far, so that a server joining later
     * can be brought to the same point.
     *
     * @remarks
     * Cluster membership changes at runtime, so a per-host queue may be created
     * long after `start()` and `subscribe()` were called on the cluster. This
     * records those calls; joining hosts replay startup and subscription
     * catch-up independently.
     */
    private state: ClusterState = {
        started: false,
        channel: null,
        handlers: [],
    };

    /**
     * Tracks this cluster's successful installations, independently of handlers
     * registered directly on a host. Teardown resets the installation count.
     */
    private readonly progress = new WeakMap<RedisQueue, HostProgress>();

    /**
     * Sends parked in {@link ClusteredRedisQueue.sendWhenInitialized}, waiting
     * for a server to appear. Kept so {@link ClusteredRedisQueue.destroy} can
     * settle them at once rather than leaving each to time out against a
     * cluster that can no longer admit a server.
     */
    private readonly waitingSends = new Set<(reason: Error) => void>();

    /** Pending startup shared by batch startup and joining-host initialization. */
    private readonly starting = new WeakMap<RedisQueue, Promise<void>>();

    /** Membership admission stays closed after the first destroy() call. */
    private closed = false;

    /** Failed cleanup tasks remain here for an explicit destroy() retry. */
    private readonly cleanup = new Set<() => Promise<void>>();

    /** Teardown shared by concurrent destroy() callers. */
    private destroying?: Promise<void>;

    /**
     * Handles for the cluster managers this queue is registered with, kept so
     * that {@link ClusteredRedisQueue.destroy} can deregister from each.
     */
    private initializedClusters: InitializedCluster[] = [];

    /**
     * Creates a clustered queue.
     *
     * @param name - queue name, used as the queue name for every per-host queue
     *        in the cluster
     * @param options - queue options; must supply {@link IMQOptions.cluster},
     *        {@link IMQOptions.clusterManagers}, or both
     * @param _mode - accepted only for {@link IMessageQueueConstructor}
     *        signature compatibility and ignored: the underlying queues always
     *        run in {@link IMQMode.BOTH}
     * @throws TypeError when neither `cluster` nor a non-empty `clusterManagers`
     *         is supplied
     *
     * @remarks
     * Construction is not inert. One {@link RedisQueue} is created per static
     * cluster entry, and every cluster manager is initialized immediately — so
     * dynamically discovered servers can join before
     * {@link ClusteredRedisQueue.start} is ever called.
     *
     * Cluster entries contribute only `id`, `host` and `port`. All other
     * connection settings, including `username` and `password`, are inherited from
     * the top-level options, so per-server credentials in a cluster entry are
     * ignored.
     */
    public constructor(
        /**
         * Name of this queue, used as the queue name for every per-host queue in
         * the cluster.
         *
         * @remarks
         * It is read when a server joins, so changing it after construction
         * affects only servers added later — which would silently split the
         * cluster across two queue names. Avoid reassigning it.
         */
        public name: string,
        options?: Partial<IMQOptions>,
        _mode: IMQMode = IMQMode.BOTH,
    ) {
        this.templateEmitter = new EventEmitter();
        this.clusterEmitter = new EventEmitter();
        this.options = buildOptions<IMQOptions>(DEFAULT_IMQ_OPTIONS, options);

        this.logger = this.options.logger || console;

        if (!this.options.cluster && !this.options.clusterManagers?.length) {
            throw new TypeError(
                'ClusteredRedisQueue: cluster ' + 'configuration is missing!',
            );
        }

        this.mqOptions = { ...this.options };

        const cluster = [...(this.mqOptions.cluster || [])];

        delete this.mqOptions.cluster;

        for (const server of cluster) {
            this.addServerWithQueueInitializing(server, false);
        }

        if (this.options.clusterManagers?.length) {
            this.verbose('Initializing cluster managers...');

            for (const manager of this.options.clusterManagers) {
                this.initializedClusters.push(
                    manager.init({
                        add: this.addServer.bind(this),
                        remove: this.removeServer.bind(this),
                        find: this.findServer.bind(this),
                    }),
                );
            }
        }
    }

    /**
     * Starts every server's queue concurrently.
     *
     * @returns this queue instance
     *
     * @remarks
     * A failure on any one server rejects this call while the others continue
     * starting, and the cluster stays in the started state — so servers that join
     * afterwards are still started automatically.
     *
     * Always emits one informational log line, regardless of
     * {@link IMQOptions.verbose}.
     */
    public async start(): Promise<ClusteredRedisQueue> {
        this.state.started = true;

        return await this.batch(
            'start',
            'Starting clustered redis message queue...',
        );
    }

    /**
     * Stops message handling on every server concurrently.
     *
     * @returns this queue instance
     *
     * @remarks
     * Connections are kept and any active subscription is retained, so servers
     * joining afterwards are still subscribed to the remembered channel while
     * remaining stopped. Use {@link ClusteredRedisQueue.destroy} to tear the
     * connections down.
     */
    public async stop(): Promise<ClusteredRedisQueue> {
        this.state.started = false;

        return await this.batch(
            'stop',
            'Stopping clustered redis message queue...',
        );
    }

    /**
     * Sends a message to one server of the cluster, selected by health-aware
     * round-robin.
     *
     * @param toQueue - queue name to which a message should be sent to
     * @param message - message data
     * @param delay - if specified, a message will be handled in the target queue
     *        after a specified period of time in milliseconds
     * @param errorHandler - callback called only when an internal error occurs
     *        during message send execution
     * @returns message identifier
     * @throws TypeError propagated from the selected server when it is in
     *         {@link IMQMode.WORKER}-only mode
     *
     * @remarks
     * This is the one operation that does not fan out — the message goes to a
     * single server, and not to a stable one.
     *
     * When the cluster currently has no servers the send is held until the first
     * server becomes ready, and rejects if none appears within 30 seconds
     * (override with the `IMQ_SEND_INIT_TIMEOUT` environment variable, in
     * milliseconds).
     */
    public async send(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string> {
        if (this.closed) {
            // admission is closed, so no server can ever arrive: waiting out
            // the initialisation timeout would stall a shutdown path for
            // IMQ_SEND_INIT_TIMEOUT on a timer that is not unref()'d
            throw new TypeError(
                'ClusteredRedisQueue: the queue was destroyed and cannot be ' +
                    'reused, so this message has nowhere to go!',
            );
        }

        if (!this.imqLength) {
            return this.sendWhenInitialized(
                toQueue,
                message,
                delay,
                errorHandler,
            );
        }

        const imq = this.selectQueue();

        return imq.send(toQueue, message, delay, errorHandler);
    }

    /**
     * Picks the next queue for a round-robin send, preferring an instance
     * whose redis connection is currently ready so messages are not routed
     * to a host that is known to be down. Falls back to the plain
     * round-robin pick when no instance reports are ready.
     */
    private selectQueue(): RedisQueue {
        const count = this.imqLength;
        const start = this.currentQueue % count;

        for (let offset = 0; offset < count; offset++) {
            const index = (start + offset) % count;
            const candidate = this.imqs[index];

            if (candidate.available) {
                this.currentQueue = index + 1;
                this.noneAvailable = false;

                return candidate;
            }
        }

        // every instance reports its connection as not ready, so the message
        // goes to a host known to be down. Reported on entering the state
        // only, and the flag is cleared by the first successful pick above,
        // so a second outage after a recovery is visible again
        if (!this.noneAvailable) {
            this.noneAvailable = true;
            this.logLine(
                'warn',
                `no available instance out of ${count}, sending to an ` +
                    'instance which is known to be down',
            );
        }

        this.currentQueue = start + 1;

        return this.imqs[start];
    }

    /**
     * Sends a message once the first cluster server becomes available.
     * Rejects (rather than hanging forever) if none appears within the
     * configured timeout and propagates any sent failure.
     */
    private sendWhenInitialized(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const onInitialized = ({ imq }: { imq: RedisQueue }): void => {
                clearTimeout(timer);
                this.waitingSends.delete(giveUp);
                imq.send(toQueue, message, delay, errorHandler).then(
                    resolve,
                    reject,
                );
            };

            const giveUp = (reason: Error): void => {
                clearTimeout(timer);
                this.clusterEmitter.removeListener(
                    'initialized',
                    onInitialized,
                );
                this.waitingSends.delete(giveUp);
                reject(reason);
            };

            const timer = setTimeout(
                () =>
                    giveUp(
                        new Error(
                            'ClusteredRedisQueue: no cluster server became ' +
                                'available to send the message',
                        ),
                    ),
                this.sendInitTimeout,
            );

            // registered so destroy() can settle this immediately: once
            // admission is closed no server can ever initialise, and waiting
            // out the timeout would hold the event loop open on a shutdown
            this.waitingSends.add(giveUp);

            this.clusterEmitter.once('initialized', onInitialized);
        });
    }

    /**
     * Destroys every server's queue — closing their connections and removing
     * their event listeners — and unregisters this cluster from all configured
     * cluster managers.
     *
     * @remarks
     * Unregistering shuts a manager down entirely once it has no clusters left,
     * which for {@link UDPClusterManager} also terminates its shared UDP worker.
     *
     * Routing membership and remembered subscriptions are cleared synchronously,
     * so queued subscription work cannot reopen a destroyed host. Teardown does
     * not wait for the subscription chain; concurrent callers await the same
     * teardown, including manager removal. Every independent cleanup is attempted;
     * failures are reported together in an AggregateError. A later destroy()
     * retries only failed tasks; successful tasks are not repeated. Membership
     * admission stays closed, including during retries. The instance must not
     * be reused.
     */
    public async destroy(): Promise<void> {
        if (this.destroying) {
            return this.destroying;
        }

        if (!this.closed) {
            this.closed = true;
            this.state.started = false;

            for (const imq of this.imqs) {
                this.cancelSync(imq);
                this.cleanup.add(() => imq.destroy());
            }

            for (const manager of this.options.clusterManagers || []) {
                for (const cluster of this.initializedClusters) {
                    this.cleanup.add(() => manager.remove(cluster));
                }
            }

            // Close routing before queued subscription or startup work can run.
            // Teardown bypasses those chains so a stalled install cannot block it.
            this.imqs = [];
            this.servers = [];
            this.imqLength = 0;
            this.state.channel = null;
            this.state.handlers = [];

            // a send parked waiting for a server can never be satisfied once
            // admission is closed, and its timer is referenced, so leaving it
            // to expire holds the event loop open for the whole timeout
            const parked = Array.from(this.waitingSends);

            this.waitingSends.clear();

            for (const giveUp of parked) {
                giveUp(
                    new Error(
                        'ClusteredRedisQueue: the queue was destroyed before ' +
                            'a cluster server became available',
                    ),
                );
            }
        }

        this.destroying = Promise.resolve()
            .then(async () => {
                this.logLine(
                    'info',
                    'Destroying clustered redis message queue...',
                );
                const results = await Promise.allSettled(
                    [...this.cleanup].map(async operation => {
                        await operation();
                        this.cleanup.delete(operation);
                    }),
                );
                const errors = results
                    .filter(result => result.status === 'rejected')
                    .map(result => result.reason);

                if (errors.length) {
                    throw new AggregateError(errors, 'Cluster teardown failed');
                }
            })
            .finally(() => {
                this.destroying = undefined;
            });

        return this.destroying;
    }

    /**
     * Deletes this queue's data on every redis host in the cluster,
     * concurrently.
     *
     * @returns this queue instance
     */
    public async clear(): Promise<ClusteredRedisQueue> {
        return await this.batch(
            'clear',
            'Clearing clustered redis message queue...',
        );
    }

    /**
     * Returns the total number of messages waiting, summed across every redis
     * host in the cluster.
     *
     * @returns sum of the per-host queue lengths
     *
     * @remarks
     * Resolves to `0` when the cluster has no servers, and rejects if any single
     * host cannot be queried. As with {@link RedisQueue.queueLength}, delayed and
     * in-flight messages are not counted.
     */
    public async queueLength(): Promise<number> {
        const promises = [];

        for (const imq of this.imqs) {
            promises.push(imq.queueLength());
        }

        const lengths = await Promise.all(promises);

        return lengths.reduce((total, length) => total + length, 0);
    }

    /**
     * Writes a diagnostic line, but only under {@link IMQOptions.verbose}.
     *
     * @param message - the line to write
     */
    private verbose(message: string): void {
        if (this.options.verbose) {
            this.logger.info(
                `[IMQ-CORE][ClusteredRedisQueue][${this.name}]: ${message}`,
            );
        }
    }

    /**
     * Writes an unconditional line through this cluster's logger, in the
     * format `verbose()` uses.
     *
     * @param level - logger method to write the line with
     * @param message - the line, which must never carry message payload,
     *        call arguments, raw redis keys or an error text
     *
     * @remarks
     * Never throws: a broken logger must not be able to change what the
     * cluster does. Every call site of this reports a state transition or a
     * lifecycle event, so no rate limiting is needed.
     */
    private logLine(level: 'info' | 'warn' | 'error', message: string): void {
        try {
            this.logger[level](
                `[IMQ-CORE][ClusteredRedisQueue][${this.name}]: ${message}`,
            );
        } catch {
            // a failing logger must never influence cluster behaviour
        }
    }

    /**
     * Batch imq action processing on all registered imqs at once
     *
     * @param action -
     * @param message -
     */
    private async batch(
        action: 'start' | 'stop' | 'clear',
        message: string,
    ): Promise<this> {
        this.logger.info(message);

        const promises: Promise<unknown>[] = [];

        for (const imq of this.imqs) {
            promises.push(
                action === 'start' ? this.startHost(imq) : imq[action](),
            );
        }

        await Promise.all(promises);

        return this;
    }

    // EventEmitter interface
    /**
     * Applies the named EventEmitter method to every underlying emitter,
     * forwarding the call across the whole cluster. Dispatch is reflective
     * (method chosen by name), so a single contained cast bridges the dynamic
     * call while the public method signatures below stay fully typed.
     *
     * @typeParam K - EventEmitter method name
     * @param method - name of the EventEmitter method to invoke
     * @param args - arguments to pass to the method
     * @returns results from each emitter call
     */
    private applyToEmitters<K extends keyof EventEmitter>(
        method: K,
        args: any[],
    ): unknown[] {
        const results: unknown[] = [];

        for (const imq of this.eventEmitters()) {
            const fn = imq[method] as unknown as (...a: any[]) => unknown;

            results.push(fn.apply(imq, args));
        }

        return results;
    }

    /**
     * Registers a listener on every server's queue and on the internal template
     * used to seed servers that join later.
     *
     * @param args - the arguments `EventEmitter.on` accepts
     * @returns this queue instance
     */
    public on(...args: any[]): this {
        this.applyToEmitters('on', args);

        return this;
    }

    /**
     * Removes a listener from every server's queue and from the internal
     * template.
     *
     * @param args - the arguments `EventEmitter.off` accepts
     * @returns this queue instance
     */
    public off(...args: any[]): this {
        this.applyToEmitters('off', args);

        return this;
    }

    /**
     * Registers a one-shot listener on every server's queue and on the internal
     * template.
     *
     * @param args - the arguments `EventEmitter.once` accepts
     * @returns this queue instance
     *
     * @remarks
     * Because registration is replicated per server, this arms one independent
     * one-shot listener per server — so the callback may run once for each
     * server in the cluster rather than once overall, and more as servers join.
     * Use {@link ClusteredRedisQueue.on} plus explicit de-registration if you
     * need at-most-once semantics.
     */
    public once(...args: any[]): this {
        this.applyToEmitters('once', args);

        return this;
    }

    /**
     * Registers a listener on every server's queue and on the internal template.
     * Alias of {@link ClusteredRedisQueue.on}.
     *
     * @param args - the arguments `EventEmitter.addListener` accepts
     * @returns this queue instance
     */
    public addListener(...args: any[]): this {
        this.applyToEmitters('addListener', args);

        return this;
    }

    /**
     * Removes a listener from every server's queue and from the internal
     * template. Alias of {@link ClusteredRedisQueue.off}.
     *
     * @param args - the arguments `EventEmitter.removeListener` accepts
     * @returns this queue instance
     */
    public removeListener(...args: any[]): this {
        this.applyToEmitters('removeListener', args);

        return this;
    }

    /**
     * Removes every listener from every server's queue and from the internal
     * template, so servers that join later also start clean.
     *
     * @param args - the arguments `EventEmitter.removeAllListeners` accepts
     * @returns this queue instance
     */
    public removeAllListeners(...args: any[]): this {
        this.applyToEmitters('removeAllListeners', args);

        return this;
    }

    /**
     * Registers a listener at the front of the queue on every server's queue and
     * on the internal template.
     *
     * @param args - the arguments `EventEmitter.prependListener` accepts
     * @returns this queue instance
     */
    public prependListener(...args: any[]): this {
        this.applyToEmitters('prependListener', args);

        return this;
    }

    /**
     * Registers a one-shot listener at the front of the queue on every server's
     * queue and on the internal template.
     *
     * @param args - the arguments `EventEmitter.prependOnceListener` accepts
     * @returns this queue instance
     *
     * @remarks
     * As with {@link ClusteredRedisQueue.once}, the listener is armed per server,
     * so it may fire more than once across the cluster.
     */
    public prependOnceListener(...args: any[]): this {
        this.applyToEmitters('prependOnceListener', args);

        return this;
    }

    /**
     * Sets the maximum listener count on every server's queue and on the internal
     * template.
     *
     * @param args - the arguments `EventEmitter.setMaxListeners` accepts
     * @returns this queue instance
     */
    public setMaxListeners(...args: any[]): this {
        this.applyToEmitters('setMaxListeners', args);

        return this;
    }

    /**
     * Returns the listeners of every server's queue plus the internal template,
     * concatenated.
     *
     * @param args - the arguments `EventEmitter.listeners` accepts
     * @returns the aggregated listeners across the cluster
     *
     * @remarks
     * Because registration is replicated, one listener registered through this
     * class appears once per server plus once for the template — so the array
     * length is a multiple of the logical listener count, not the count itself.
     * Do not compare it against
     * {@link ClusteredRedisQueue.listenerCount}, which reports a single server.
     *
     * The return type is deliberately widened to `any[]`, so Node's per-event
     * listener typing is not available here.
     */
    public listeners(...args: any[]): any[] {
        return this.applyToEmitters('listeners', args).flat();
    }

    /**
     * Returns the raw listeners of every server's queue plus the internal
     * template, concatenated.
     *
     * @param args - the arguments `EventEmitter.rawListeners` accepts
     * @returns the aggregated raw listeners across the cluster
     *
     * @remarks
     * Aggregated in the same way as {@link ClusteredRedisQueue.listeners}, with
     * the same multiplicity caveat.
     */
    public rawListeners(...args: any[]): any[] {
        return this.applyToEmitters('rawListeners', args).flat();
    }

    /**
     * Returns the maximum listener count of the internal template emitter.
     *
     * @returns the template's maximum listener count
     *
     * @remarks
     * Reads the template only — never the underlying per-server queues.
     */
    public getMaxListeners(): number {
        return this.templateEmitter.getMaxListeners();
    }

    /**
     * Emits an event on every server's queue and on the internal template, so
     * each listener registered through this class runs once per server.
     *
     * @param args - the arguments `EventEmitter.emit` accepts
     * @returns always `true`
     *
     * @remarks
     * The per-emitter results are discarded, so unlike `EventEmitter.emit` the
     * return value does not report whether the event had any listeners — it is
     * `true` even for an empty cluster with no listeners at all.
     */
    public emit(...args: any[]): boolean {
        this.applyToEmitters('emit', args);

        return true;
    }

    /**
     * Returns the event names reported by a single representative emitter.
     *
     * @returns the event names from the first server's queue, or from the internal
     *          template when the cluster is empty
     *
     * @remarks
     * Like {@link ClusteredRedisQueue.listenerCount}, this does not aggregate
     * across the cluster.
     */
    public eventNames(): (keyof EventMap)[] {
        const source = this.imqs[0] || this.templateEmitter;

        return source.eventNames() as (keyof EventMap)[];
    }

    /**
     * Returns the listener count reported by a single representative emitter.
     *
     * @param args - the arguments `EventEmitter.listenerCount` accepts
     * @returns the count from the first server's queue, or from the internal
     *          template when the cluster is empty
     *
     * @remarks
     * This deliberately does not aggregate, which makes it inconsistent with
     * {@link ClusteredRedisQueue.listeners}: for a three-server cluster with one
     * registered `message` listener this returns `1` while `listeners('message')`
     * returns four entries.
     */
    public listenerCount(...args: any[]): number {
        const source = this.imqs[0] || this.templateEmitter;
        const fn = source.listenerCount as (...a: any[]) => number;

        return fn.apply(source, args);
    }

    /**
     * Publishes the payload on every redis host in the cluster.
     *
     * @param data - payload to publish as a channel message
     * @param toName - optional different pub/sub name to publish to
     * @throws TypeError propagated from any host that has no writer connection
     *
     * @remarks
     * This is the opposite of {@link ClusteredRedisQueue.send}: the same payload
     * goes to all hosts. A subscriber connected to several of them therefore
     * receives one copy per host.
     *
     * Publication is not atomic — if any host has no writer connection the call
     * rejects even though other hosts may already have published. On an empty
     * cluster it resolves without publishing anything — reporting that through
     * the logger on entering the state — and unlike `send()` it does not wait
     * for a server to appear.
     */
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.publish(data, toName));
        }

        // an empty cluster resolves an empty Promise.all, so the caller is
        // told the event went out while nothing was published at all.
        // Reported on entering the state only
        if (!promises.length) {
            if (!this.noPublishTargets) {
                this.noPublishTargets = true;
                this.logLine(
                    'error',
                    `nothing published to channel ${
                        toName || this.name
                    }: knownServers=0`,
                );
            }
        } else {
            this.noPublishTargets = false;
        }

        await Promise.all(promises);
    }

    /**
     * Subscribes the given handler on every redis host in the cluster, and
     * remembers the subscription so servers that join later are subscribed
     * automatically.
     *
     * @param channel - channel name within the queue's prefix namespace
     * @param handler - invoked with the parsed payload of each published message
     * @throws TypeError when no channel name is given, or when a different
     *         channel name is supplied while this instance already remembers
     *         one - both are raised here, so they fire on an empty cluster too,
     *         where there is no underlying queue to raise them
     *
     * @remarks
     * Only one channel per instance is supported. Calling this again with the
     * same channel registers an additional handler — every registration is
     * remembered and all of them are invoked, including the same function
     * registered twice. Calling it with a different channel throws before any
     * state is touched, so the remembered channel keeps naming the channel that
     * is actually subscribed.
     *
     * Servers joining later are given every handler registered before they
     * joined, in registration order.
     *
     * Subscription uses its own connection and does not require start(), even
     * when a host's startup fails or stalls. Subscription changes serialise per
     * host, so a call can wait behind an earlier operation that never settles.
     *
     * A rejected call is not retryable: its registration remains remembered and
     * may already be installed on some hosts. Calling again adds another copy,
     * including for future hosts. To rebuild a known registration set, await
     * unsubscribe() and then register the desired handlers again.
     *
     * A host that refused the registration is not left behind: the cluster
     * retries its catch-up on its own, with capped backoff, until it succeeds,
     * the host leaves or the cluster is destroyed. A rejection therefore reports
     * that a host was unreachable when the call was made, not that it stays
     * unsubscribed.
     *
     * The handler receives one invocation per host that delivers the message.
     */
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => void,
    ): Promise<void> {
        if (this.closed) {
            throw new TypeError(
                'ClusteredRedisQueue: the queue was destroyed and cannot be ' +
                    'reused, so this subscription would never reach a server!',
            );
        }

        if (!channel) {
            throw new TypeError(
                `${channel}: No subscription channel name provided!`,
            );
        }

        if (this.state.channel && this.state.channel !== channel) {
            throw new TypeError(
                `Invalid channel name provided: expected "${
                    this.state.channel
                }", but "${channel}" given instead!`,
            );
        }

        this.state.channel = channel;
        this.state.handlers.push(handler);

        this.logLine(
            'info',
            `registered handler #${this.state.handlers.length} for channel ` +
                `${channel}`,
        );

        await Promise.all(
            this.imqs.map(imq =>
                this.syncHost(imq).catch(err => {
                    // a member that refuses a live registration has no other
                    // route back: the caller cannot retry, because calling
                    // again registers a second copy, and a service that
                    // subscribes once at start-up never registers again. So the
                    // cluster retries on its own, exactly as it does for a join
                    this.scheduleSync(imq);

                    throw err;
                }),
            ),
        );
    }

    /**
     * Unsubscribes from the channel on every redis host and forgets every
     * remembered handler, so servers joining later are no longer subscribed
     * automatically.
     *
     * @remarks
     * Resolves without effect on an empty cluster.
     *
     * Clears the remembered channel and handlers immediately, then queues each
     * host's teardown behind its current subscription work. A stalled operation
     * on that host therefore also stalls unsubscribe(). Later catch-up reads the
     * cluster's installation count after teardown, even if an earlier run
     * temporarily installed handlers from the replacement list.
     */
    public async unsubscribe(): Promise<void> {
        this.state.channel = null;
        this.state.handlers = [];

        await Promise.all(
            this.imqs.map(imq =>
                this.enqueue(imq, async () => {
                    try {
                        await imq.unsubscribe();
                    } finally {
                        this.progressOf(imq).installed = 0;
                    }
                }),
            ),
        );
    }

    /**
     * Adds a single server to the cluster and returns its registration record.
     *
     * @param server - address of the server to add
     * @returns the registration record: the resolved `id`, `host` and `port` plus
     *          the {@link RedisQueue} instance (`imq`) created for that host, so
     *          callers can inspect or address that specific host
     *
     * @remarks
     * Registration is idempotent, and the match rule is broader than an id
     * comparison: a server counts as already present when its `id` matches an
     * existing entry or when its host and port do. Two different ids on the
     * same host and port are therefore treated as one server, and the existing
     * record is returned unchanged without creating a queue.
     *
     * For a genuinely new server this returns as soon as the record is created —
     * starting the queue and re-applying any active subscription happen
     * asynchronously afterwards. Once destroy() begins, discovery is ignored:
     * the returned address has no queue and is not admitted to membership.
     */
    protected addServer(server: IServerInput): ClusterServer {
        this.verbose(`Adding new server: ${JSON.stringify(server)}`);

        return this.addServerWithQueueInitializing(server, true);
    }

    /**
     * Removes a server from the cluster, matching by `id` or by host and port.
     *
     * @param server - address of the server to remove
     *
     * @remarks
     * A silent no-op when no server matches. Routing stops using the host
     * immediately, but teardown of its redis connections is started in the
     * background and not awaited: in-flight work on that host is not drained,
     * and teardown errors are only logged.
     *
     * Because the underlying queues are matched by host and port, all entries
     * sharing an address are removed together.
     */
    protected removeServer(server: IServerInput): void {
        this.verbose(`Removing the server: ${JSON.stringify(server)}`);

        const remove = this.findServer(server);

        if (!remove) {
            return;
        }

        const imqToRemove = remove.imq;

        if (imqToRemove) {
            // a retry scheduled for this host must not outlive it
            this.cancelSync(imqToRemove);

            // dropped from routing first: a catch-up run in progress tests
            // membership between handlers and stops as soon as it sees this
            this.imqs = this.imqs.filter(
                imq => imqToRemove.redisKey !== imq.redisKey,
            );

            // not queued behind this host's other work: a queue wedged on a
            // connection that never answers would then never be torn down at
            // all, and teardown is the one operation that has to happen
            // regardless of what the host is doing
            imqToRemove
                .destroy()
                .catch((err: unknown) =>
                    this.verbose(`Error destroying removed server: ${err}`),
                );
        }

        this.imqLength = this.imqs.length;
        this.servers = this.servers.filter(
            existing => !ClusteredRedisQueue.matchServers(existing, server),
        );
        this.clusterEmitter.emit('remove', {
            server: remove,
            imq: imqToRemove,
        });
    }

    /**
     * Adds a server to the cluster, optionally bringing its queue up to the
     * cluster's current state.
     *
     * @param server - the server to add
     * @param initializeQueue - whether to replay `start`/`subscribe` onto the
     *        new queue. Passed `false` while the cluster is still being
     *        constructed, when there is no state to replay yet
     * @returns the server as registered, which is the existing entry when one
     *          already matched
     */
    private addServerWithQueueInitializing(
        server: ClusterServer,
        initializeQueue: boolean = true,
    ): ClusterServer {
        if (this.closed) {
            return { ...server, imq: undefined };
        }

        const existingServer = this.findServer(server);

        if (existingServer) {
            return existingServer;
        }

        const newServer: ClusterServer = {
            id: server.id,
            host: server.host,
            port: server.port,
        };

        // carried through only when the entry actually states it: the entry is
        // spread over the cluster-wide options below, and a key present but
        // undefined would blank out the top-level value rather than fall back
        // to it
        if (server.tls !== undefined) {
            newServer.tls = server.tls;
        }

        const opts = { ...this.mqOptions, ...newServer };
        const imq = new RedisQueue(this.name, opts);

        copyEventEmitter(this.templateEmitter, imq);

        newServer.imq = imq;

        // registered before the catch-up run starts, so that run can test
        // membership against `imqs` and see the host it is working on. Nothing
        // can observe the order: there is no await between here and the call
        this.imqs.push(imq);
        this.servers.push(newServer);

        if (initializeQueue) {
            // Lifecycle and subscription use separate connections: a stalled
            // start must not hold up the host's subscription chain.
            const started = this.startHost(imq);
            const synced = this.syncHost(imq);

            // Sends park on this event, so a host that only becomes usable
            // after a retry has to reach it too, or they wait out their whole
            // budget against a cluster that recovered. A host dropped while it
            // was being brought up to date never became a member, and
            // announcing it would release those sends onto a queue that is
            // being destroyed. Exactly one of the two paths below reaches this:
            // a join whose legs both succeeded, or a retry repairing a catch-up
            // whose failure already rejected that join
            const announce = (): void => {
                if (!this.imqs.includes(imq)) {
                    return;
                }

                this.clusterEmitter.emit('initialized', {
                    server: newServer,
                    imq,
                });
            };

            // only the subscription leg is retried. A failed start is already
            // retryable through an explicit start(), and retrying it here would
            // poll a connection object the reconnect path owns; a failed
            // catch-up has no other route back
            synced.catch(() => this.scheduleSync(imq, started, announce));

            Promise.all([started, synced]).then(
                announce,
                // reported inside the run; without a handler here a host that
                // simply refuses a connection - routine - becomes an unhandled
                // rejection, which is fatal on current node defaults
                () => undefined,
            );
        }

        this.clusterEmitter.emit('add', { server: newServer, imq });
        this.imqLength = this.imqs.length;

        return newServer;
    }

    /**
     * Every emitter a listener registered on this cluster must reach.
     *
     * @returns the per-host queues plus the template emitter
     *
     * @remarks
     * The template emitter is included so that listeners registered now are
     * also carried onto queues created later, as servers join.
     */
    private eventEmitters(): EventEmitter[] {
        return [...this.imqs, this.templateEmitter];
    }

    /**
     * Appends one operation to a host's serialised queue.
     *
     * @param imq - the queue the operation belongs to
     * @param operation - the work to run once everything before it has finished
     * @returns a promise for this operation alone, which rejects if it fails
     *
     * @remarks
     * Every `subscribe`, `unsubscribe` and catch-up run for a host goes through
     * here, so operations on one host never overlap, while different hosts stay
     * independent. The tail kept for the next operation is deliberately
     * repaired with a `catch`: chaining onto a rejected tail would make one
     * failed operation reject every operation the host is ever given again,
     * which is precisely the "host that silently stopped working" this class
     * has to avoid. The caller still receives the failure, through the returned
     * promise.
     */
    private enqueue(
        imq: RedisQueue,
        operation: () => Promise<void>,
    ): Promise<void> {
        const progress = this.progressOf(imq);
        const run = progress.chain.then(operation);

        progress.chain = run.catch(() => undefined);

        return run;
    }

    /**
     * Returns the progress record for a host, creating it on first use.
     *
     * @param imq - the queue to look up
     * @returns that host's progress record
     */
    private progressOf(imq: RedisQueue): HostProgress {
        let progress = this.progress.get(imq);

        if (!progress) {
            progress = {
                chain: Promise.resolve(),
                installed: 0,
                retryAttempts: 0,
            };

            this.progress.set(imq, progress);
        }

        return progress;
    }

    /**
     * Starts a joining host if it still belongs to a started cluster.
     * Subscription catch-up proceeds independently of this lifecycle operation.
     */
    private startHost(imq: RedisQueue): Promise<void> {
        // initial eligibility is decided here, synchronously, and rechecked
        // again before starting: the
        // promise is cached the moment it is created, so a body that decides
        // later hands a caller arriving afterwards a settled promise whose
        // decision was made against state this caller has since changed. That
        // is how `cluster.start()` could join a run created while the cluster
        // was still stopped and never start the host at all
        if (!this.state.started || !this.imqs.includes(imq)) {
            return Promise.resolve();
        }

        const pending = this.starting.get(imq);

        if (pending) {
            return pending;
        }

        const run = Promise.resolve()
            .then(async () => {
                // rechecked here as well as synchronously above: a stop() can
                // land between creating this run and the microtask that runs
                // it, and starting a host the cluster has just stopped leaves
                // the cluster stopped with a host running
                if (this.state.started && this.imqs.includes(imq)) {
                    try {
                        await imq.start();
                    } catch (err) {
                        this.logLine(
                            'error',
                            `server ${imq.redisKey} failed to start, code ` +
                                `${errorCode(err)}: the node is not ready to serve queues`,
                        );

                        throw err;
                    }
                }
            })
            .finally(() => {
                this.starting.delete(imq);
            });

        this.starting.set(imq, run);

        return run;
    }

    /**
     * Retries a host's subscription catch-up until it succeeds, the host leaves
     * the cluster, or the cluster is destroyed.
     *
     * @param imq - the queue whose catch-up failed
     * @param started - the joining host's startup, which the announcement waits
     *        for. A live registration has nothing to announce and omits it
     * @param announce - emits `initialized` for a joining host that only became
     *        usable through this retry. Omitted by a live registration, whose
     *        host is already a member that sends are routed to
     *
     * @remarks
     * Both routes to a first subscribe end here: a joining host's catch-up, and
     * a live registration on a host that is already a member, which is the only
     * route a statically configured cluster ever takes.
     *
     * A host whose first {@link RedisQueue.subscribe} rejects records
     * nothing: `subscriptionHandlers` stays empty, so the connection layer's
     * own reconnect has nothing to replay and restores a socket subscribed to
     * no channel. Without this, that host never receives another installation —
     * `start()` fans out startup only, a re-announced address is recognised as a
     * known server and skipped, and a service that subscribes once at boot never
     * registers again. The host stays a silent member for the life of the
     * process while every probe it answers reports health.
     *
     * Retrying is safe because catch-up is idempotent: {@link
     * ClusteredRedisQueue.syncHost} reads the cluster-owned installed count
     * inside the per-host chain and installs only the missing suffix, so a retry
     * cannot duplicate a handler that did land. The backoff mirrors the
     * connection layer's, which this has to outlive.
     */
    private scheduleSync(
        imq: RedisQueue,
        started: Promise<void> = Promise.resolve(),
        announce: () => void = () => undefined,
    ): void {
        if (this.closed || !this.imqs.includes(imq)) {
            return;
        }

        const progress = this.progressOf(imq);

        if (progress.retryTimer) {
            return;
        }

        const attempts = progress.retryAttempts + 1;
        const delay = Math.min(
            SYNC_RETRY_MAX_DELAY,
            SYNC_RETRY_BASE_DELAY * 2 ** (attempts - 1),
        );

        progress.retryAttempts = attempts;

        const timer = setTimeout(() => {
            progress.retryTimer = undefined;

            if (this.closed || !this.imqs.includes(imq)) {
                return;
            }

            this.syncHost(imq).then(
                () => {
                    progress.retryAttempts = 0;

                    // the host is only usable once its lifecycle came up too
                    started.then(announce, () => undefined);
                },
                () => this.scheduleSync(imq, started, announce),
            );
        }, delay);

        // a host that never comes back must not hold the process open
        timer.unref?.();
        progress.retryTimer = timer;
    }

    /**
     * Cancels a pending catch-up retry for a host being torn down.
     *
     * @param imq - the queue leaving the cluster
     */
    private cancelSync(imq: RedisQueue): void {
        const progress = this.progress.get(imq);

        if (progress?.retryTimer) {
            clearTimeout(progress.retryTimer);
            progress.retryTimer = undefined;
        }
    }

    /**
     * Installs registrations this cluster has not yet installed on a host.
     *
     * @param imq - the queue to bring up to date
     * @returns this run's completion, rejecting on a failed installation
     *
     * @remarks
     * Both live registrations and joining hosts use the same serialised path.
     * Each run reads the cluster-owned count inside the chain, so repeating it adds
     * nothing. A queued teardown may erase a temporary installation; the run
     * behind that teardown will then see and install the missing suffix again.
     */
    private syncHost(imq: RedisQueue): Promise<void> {
        return this.enqueue(imq, async () => {
            const progress = this.progressOf(imq);
            const channel = this.state.channel;

            if (!channel) {
                return;
            }

            let installed = 0;

            try {
                for (
                    let i = progress.installed;
                    i < this.state.handlers.length;
                    i++
                ) {
                    if (!this.imqs.includes(imq)) {
                        return;
                    }

                    if (this.state.channel !== channel) {
                        return;
                    }

                    await imq.subscribe(channel, this.state.handlers[i]);

                    // rechecked after the await: teardown bypasses this chain,
                    // so the host can have been removed or destroyed while the
                    // subscribe was in flight. Recording it would leave the
                    // counter claiming an install on a queue that is gone, and
                    // the handler it just attached is torn down with the host
                    if (!this.imqs.includes(imq)) {
                        return;
                    }

                    progress.installed = i + 1;
                    installed++;
                }
            } catch (err) {
                this.logLine(
                    'error',
                    `server ${imq.redisKey} failed to subscribe to channel ` +
                        `${channel}, code ${errorCode(err)}: some handlers remain ` +
                        'uninstalled until the retry the cluster schedules for ' +
                        'this host succeeds',
                );

                throw err;
            } finally {
                if (installed) {
                    this.logLine(
                        'info',
                        `server ${imq.redisKey} installed ${installed} handler(s) ` +
                            `for channel ${channel}`,
                    );
                }
            }
        });
    }

    /**
     * Finds an already-registered server matching the given one.
     *
     * @param server - the server to look for
     * @returns the registered entry, or `undefined` when it is new
     */
    private findServer(server: IServerInput): ClusterServer | undefined {
        return this.servers.find(existing =>
            ClusteredRedisQueue.matchServers(existing, server),
        );
    }

    /**
     * Decides whether two server descriptions refer to the same server.
     *
     * @param source - one server description
     * @param target - the other
     * @returns whether they are the same server
     */
    private static matchServers(
        source: IServerInput,
        target: IServerInput,
    ): boolean {
        const sameAddress =
            target.host === source.host && target.port === source.port;

        if (!target.id && !source.id) {
            return sameAddress;
        }

        const sameId = target.id === source.id;

        return sameId || sameAddress;
    }
}
