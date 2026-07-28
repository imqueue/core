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
import { buildOptions, copyEventEmitter } from './helpers/index.js';
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
     */
    imq?: RedisQueue;
}

interface ClusterState {
    started: boolean;
    subscription: {
        channel: string;
        handler: (data: JsonObject) => void;
    } | null;
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
 * Every fan-out uses `Promise.all`, so one failing host fails the whole call with
 * no partial-failure reporting and no rollback.
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
     * Template EventEmitter instance used to replicate queue EventEmitters when
     * dynamically modifying the cluster
     */
    private readonly templateEmitter: EventEmitter;

    /**
     * Cluster EventEmitter instance used to notify about changes of
     * cluster servers
     */
    private readonly clusterEmitter: EventEmitter;

    private state: ClusterState = {
        started: false,
        subscription: null,
    };

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

                return candidate;
            }
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
                imq.send(toQueue, message, delay, errorHandler).then(
                    resolve,
                    reject,
                );
            };

            const timer = setTimeout(() => {
                this.clusterEmitter.removeListener(
                    'initialized',
                    onInitialized,
                );
                reject(
                    new Error(
                        'ClusteredRedisQueue: no cluster server became ' +
                            'available to send the message',
                    ),
                );
            }, this.sendInitTimeout);

            this.clusterEmitter.once('initialized', onInitialized);
        });
    }

    /**
     * Destroys every server's queue — closing their connections and removing
     * their event listeners — then unregisters this cluster from all configured
     * cluster managers.
     *
     * @remarks
     * Unregistering shuts a manager down entirely once it has no clusters left,
     * which for {@link UDPClusterManager} also terminates its shared UDP worker.
     *
     * The instance must not be reused afterwards: internal routing state is not
     * cleared, so a subsequent {@link ClusteredRedisQueue.send} would silently
     * re-open a connection.
     */
    public async destroy(): Promise<void> {
        this.state.started = false;

        await this.batch(
            'destroy',
            'Destroying clustered redis message queue...',
        );

        if (!this.options.clusterManagers?.length) {
            return;
        }

        for (const manager of this.options.clusterManagers) {
            for (const cluster of this.initializedClusters) {
                await manager.remove(cluster);
            }
        }
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

    private verbose(message: string): void {
        if (this.options.verbose) {
            this.logger.info(
                `[IMQ-CORE][ClusteredRedisQueue][${this.name}]: ${message}`,
            );
        }
    }

    /**
     * Batch imq action processing on all registered imqs at once
     *
     * @param action -
     * @param message -
     */
    private async batch(
        action: 'start' | 'stop' | 'destroy' | 'clear',
        message: string,
    ): Promise<this> {
        this.logger.info(message);

        const promises: Promise<unknown>[] = [];

        for (const imq of this.imqs) {
            const run = imq[action] as () => Promise<unknown>;

            promises.push(run.call(imq));
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
     * cluster it resolves without publishing anything, and unlike `send()` it does
     * not wait for a server to appear.
     */
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.publish(data, toName));
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
     * @throws TypeError when a different channel name is supplied while a
     *         subscription is already open on the underlying queues
     *
     * @remarks
     * Only one channel per instance is supported. Calling this again with the
     * same channel registers the handler a second time; calling it with a
     * different channel rejects — and the remembered subscription is left
     * pointing at the rejected name, which is what newly joining servers would
     * then use.
     *
     * The handler receives one invocation per host that delivers the message.
     */
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => void,
    ): Promise<void> {
        this.state.subscription = { channel, handler };

        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.subscribe(channel, handler));
        }

        await Promise.all(promises);
    }

    /**
     * Unsubscribes from the channel on every redis host and forgets the
     * remembered subscription, so servers joining later are no longer subscribed
     * automatically.
     *
     * @remarks
     * Resolves without effect on an empty cluster.
     */
    public async unsubscribe(): Promise<void> {
        this.state.subscription = null;

        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.unsubscribe());
        }

        await Promise.all(promises);
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
     * asynchronously afterwards.
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
            this.imqs = this.imqs.filter(
                imq => imqToRemove.redisKey !== imq.redisKey,
            );
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

    private addServerWithQueueInitializing(
        server: ClusterServer,
        initializeQueue: boolean = true,
    ): ClusterServer {
        const existingServer = this.findServer(server);

        if (existingServer) {
            return existingServer;
        }

        const newServer: ClusterServer = {
            id: server.id,
            host: server.host,
            port: server.port,
        };

        const opts = { ...this.mqOptions, ...newServer };
        const imq = new RedisQueue(this.name, opts);

        copyEventEmitter(this.templateEmitter, imq);

        if (initializeQueue) {
            this.initializeQueue(imq).then(() => {
                this.clusterEmitter.emit('initialized', {
                    server: newServer,
                    imq,
                });
            });
        }

        newServer.imq = imq;

        this.imqs.push(imq);
        this.servers.push(newServer);
        this.clusterEmitter.emit('add', { server: newServer, imq });
        this.imqLength = this.imqs.length;

        return newServer;
    }

    private eventEmitters(): EventEmitter[] {
        return [...this.imqs, this.templateEmitter];
    }

    private async initializeQueue(imq: RedisQueue): Promise<void> {
        this.verbose(
            `Initializing queue with state: ${JSON.stringify(this.state)}`,
        );

        if (this.state.started) {
            await imq.start();
        }

        if (this.state.subscription) {
            await imq.subscribe(
                this.state.subscription.channel,
                this.state.subscription.handler,
            );
        }
    }

    private findServer(server: IServerInput): ClusterServer | undefined {
        return this.servers.find(existing =>
            ClusteredRedisQueue.matchServers(existing, server),
        );
    }

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
