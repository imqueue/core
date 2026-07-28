/*!
 * Basic types and interfaces
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
import { IMQMode } from './IMQMode.js';
import { ClusterManager } from './ClusterManager.js';

export { EventEmitter } from 'node:events';

/**
 * Any JSON value.
 *
 * @remarks
 * `undefined` is accepted by the type for ergonomics but is not preserved by
 * serialization — `undefined` properties are silently dropped when a message is
 * sent.
 */
export type AnyJson =
    | boolean
    | number
    | string
    | null
    | undefined
    | JsonArray
    | JsonObject;

/**
 * Represents JSON serializable object
 */
export interface JsonObject {
    /**
     * Any string key mapping to any JSON value.
     */
    [key: string]: AnyJson;
}

/**
 * Represents JSON-serializable array
 */
export interface JsonArray extends Array<AnyJson> {}

/**
 * Minimal logging contract the framework writes diagnostics through. The global
 * `console` satisfies it, and it is the default.
 *
 * Pass an implementation as {@link IMQOptions.logger} to redirect queue output,
 * or a no-op implementation to silence it. The method names match the members of
 * {@link LogLevel}, so a level can be used as a property lookup on a logger.
 */
export interface ILogger {
    /**
     * Writes a message at the `log` level.
     *
     * @param args - values to log
     */
    log(...args: unknown[]): void;

    /**
     * Writes a message at the `info` level.
     *
     * @param args - values to log
     */
    info(...args: unknown[]): void;

    /**
     * Writes a message at the `warn` level.
     *
     * @param args - values to log
     */
    warn(...args: unknown[]): void;

    /**
     * Writes a message at the `error` level.
     *
     * @param args - values to log
     */
    error(...args: unknown[]): void;
}

/**
 * Internal envelope of a queued message as it is stored in Redis: a generated
 * id, the caller's payload, and the name of the queue that sent it.
 *
 * @remarks
 * Consumers never receive this object. The `message` event delivers the payload,
 * the id and the source queue name as three separate arguments.
 */
export interface IMessage {
    /**
     * Unique identifier assigned to the message when it was sent.
     */
    id: string;

    /**
     * The message payload. Must be a JSON object — a bare string, number or
     * array is not a valid message body.
     */
    message: JsonObject;

    /**
     * Name of the queue that produced the message.
     */
    from: string;

    /**
     * Intended delay in milliseconds.
     *
     * @deprecated Inert, and always absent in practice — the Redis adapter never
     * writes this field and never reads it. Delays are carried in the queue's
     * delayed sorted set, not in the message envelope, so pass the delay to
     * {@link IMessageQueue.send} instead. Scheduled for removal in the next major.
     */
    delay?: number;
}

/**
 * Address of a cluster server, as supplied to the cluster membership operations
 * {@link ICluster.add}, {@link ICluster.remove} and {@link ICluster.find}.
 *
 * @remarks
 * Servers are matched by `id` when both sides carry one, and by host and port
 * otherwise. This is {@link IMessageQueueConnection} without the credentials.
 */
export interface IServerInput {
    /**
     * Identifier used to match this server against cluster membership. When
     * omitted, matching falls back to host and port.
     */
    id?: string;

    /**
     * Host name or IP address of the server.
     */
    host: string;

    /**
     * TCP port the server listens on.
     */
    port: number;
}

/**
 * A single queue-host endpoint: where to connect and, optionally, how to
 * authenticate.
 *
 * @remarks
 * Used both as the element type of {@link IMQOptions.cluster} and, through
 * `Partial`, as the connection part of {@link IMQOptions} itself — where it
 * defaults to `localhost:6379` without authentication.
 */
export interface IMessageQueueConnection extends IMessageQueueAuthConnection {
    /**
     * Identifier used to match this endpoint against cluster membership.
     * Meaningful on `cluster` entries only, not at the top level of
     * {@link IMQOptions}.
     */
    id?: string;

    /**
     * Host name or IP address of the queue host. Defaults to `localhost`.
     */
    host: string;

    /**
     * TCP port of the queue host. Defaults to `6379`.
     */
    port: number;
}

/**
 * Optional credentials for a queue host, forwarded to the Redis client as
 * `username` and `password`.
 *
 * Supply both for a Redis ACL user, or just `password` for a `requirepass`-only
 * server. Omit both to connect unauthenticated, which is the default.
 */
export interface IMessageQueueAuthConnection {
    /**
     * Redis ACL user name. Omit for a server that only uses `requirepass`.
     */
    username?: string;

    /**
     * Password for the queue host.
     */
    password?: string;
}

/**
 * Options accepted by every queue implementation.
 *
 * Anything omitted falls back to {@link DEFAULT_IMQ_OPTIONS} — `localhost:6379`,
 * prefix `imq`, cleanup off, safe delivery off, gzip off, a 5000 ms watcher check
 * and safe-delivery TTL, and signal handling on.
 *
 * @remarks
 * Only `cleanup` and `cleanupFilter` are required by the type, even though every
 * constructor and {@link IMQ.create} accepts a `Partial<IMQOptions>` — prefer
 * `Partial<IMQOptions>` when declaring option literals.
 *
 * The inherited `id` is meaningful only on {@link IMQOptions.cluster} entries;
 * the queue itself never reads it.
 */
export interface IMQOptions extends Partial<IMessageQueueConnection> {
    /**
     * Turns on/off the watcher's periodic removal of orphaned keys. Defaults to
     * `false`.
     *
     * @remarks
     * This is a destructive sweep. Only the instance holding the watcher lock
     * performs it, on the {@link IMQOptions.safeDeliveryTtl} interval, and it
     * deletes every key under `<prefix>:<cleanupFilter>` that does not belong to
     * a currently connected imq client — with one sweep of grace for clients seen
     * during the previous sweep. That means it will delete messages queued for a
     * consumer that is not running, so enable it only where queue names map
     * one-to-one onto live processes.
     */
    cleanup: boolean;

    /**
     * Redis glob pattern, appended to the prefix as `<prefix>:<cleanupFilter>`,
     * selecting which keys the cleanup sweep considers. Defaults to `'*'` —
     * every key in the namespace.
     *
     * @remarks
     * This matches Redis key names, not queue names. The same pattern is also
     * matched against connection names when deciding which keys belong to live
     * clients. Used only when {@link IMQOptions.cleanup} is enabled.
     */
    cleanupFilter: string;

    /**
     * Queue adapter vendor name. Defaults to `'Redis'`, which is the only
     * supported value.
     *
     * @remarks
     * Honoured only by {@link IMQ.create}, which throws a `TypeError` for any
     * other value. Ignored when a queue class is instantiated directly, because
     * {@link DEFAULT_IMQ_OPTIONS} carries no `vendor` key.
     */
    vendor?: string;

    /**
     * Global key namespace for everything this queue writes. Defaults to `'imq'`.
     *
     * @remarks
     * The prefix scopes more than the queue keys: it also scopes the delayed set,
     * the pub/sub channel names, and the watcher election lock
     * `<prefix>:watch:lock`. All queues sharing a prefix on the same Redis host
     * therefore elect exactly one watcher between them, and
     * {@link IMessageQueue.publish} can only reach names inside the same prefix.
     * Use distinct prefixes to isolate unrelated applications on a shared Redis.
     */
    prefix?: string;

    /**
     * Logger used for queue diagnostics. Defaults to `console`.
     *
     * @remarks
     * Connection lifecycle messages and all internal errors are written here
     * regardless of {@link IMQOptions.verbose} — only verbose messages are gated
     * by it. Pass a no-op {@link ILogger} to silence the queue entirely.
     */
    logger?: ILogger;

    /**
     * Interval in milliseconds of the periodic watcher check. Defaults to 5000.
     *
     * @remarks
     * Each tick re-elects a watcher owner if none exists and, on
     * worker-capable instances, releases due delayed messages — acting as the
     * fallback when Redis keyspace notifications are unavailable. That makes this
     * value the worst-case extra latency for a delayed message. Setting it to `0`
     * disables both behaviours.
     */
    watcherCheckDelay?: number;

    /**
     * Enable message compression for serialization. Increases a worker CPU load
     * but decreases network traffic between workers and the queue host. Defaults
     * to `false`.
     *
     * @remarks
     * Must be set identically on every producer and consumer of a queue: a
     * mismatch makes deserialization fail, which emits an `error` event with the
     * event name `OnMessage` and drops the message — permanently, even under
     * {@link IMQOptions.safeDelivery}, because the worker key is released
     * immediately afterwards.
     *
     * Applies to queue messages only. {@link IMessageQueue.publish} and
     * {@link IMessageQueue.subscribe} payloads are always plain JSON.
     */
    useGzip?: boolean;

    /**
     * Enable guaranteed message delivery. When enabled, reading a message
     * moves it atomically out of the queue into a worker-owned key instead of
     * popping it outright, so a worker that dies before it even starts on a
     * message leaves that message behind for the watcher to re-queue rather
     * than taking it down with the process.
     *
     * The guarantee covers that hand-off, not the processing. The worker key
     * is released as soon as the message is dispatched to the `message`
     * listener, so a worker killed while its handler is still running loses
     * that message exactly as it would with safe delivery off — draining
     * in-flight work before exit is up to the application. Delivery is
     * at-least-once in either mode, so handlers should be idempotent.
     *
     * @defaultValue false
     */
    safeDelivery?: boolean;

    /**
     * Lease deadline (in milliseconds) stamped onto the worker key when
     * safeDelivery moves a message out of the queue, and the interval on which
     * the watcher sweeps for expired keys. A worker key still present once its
     * deadline has passed is treated as abandoned, and its message is moved
     * back onto the main queue.
     *
     * This is a recovery deadline for an abandoned hand-off, not a processing
     * deadline. The key is released when the message is dispatched, so a slow
     * handler is neither interrupted nor re-queued for taking too long, and
     * raising this value extends no protection over long-running work — tune it
     * for how quickly an abandoned message should come back.
     *
     * @defaultValue 5000
     *
     * @remarks
     * This value applies whether or not {@link IMQOptions.safeDelivery} is on:
     * it always sets the period of the watcher's maintenance sweep, which also
     * drives the {@link IMQOptions.cleanup} pass. Setting it to `null` or
     * `undefined` disables that interval altogether, so neither lease recovery
     * nor cleanup runs.
     *
     * In safe-delivery mode it additionally sets the reader's blocking-pop
     * timeout to half the TTL, with a 100 ms floor, after which the reader
     * regenerates the lease and blocks again. Very small values therefore
     * increase Redis round-trips without further reducing latency.
     */
    safeDeliveryTtl?: number;

    /**
     * Redis servers to spread this queue across. Supplying this — or
     * {@link IMQOptions.clusterManagers} — makes {@link IMQ.create} return a
     * {@link ClusteredRedisQueue}.
     *
     * @remarks
     * Each entry carries its own host, port and optional `id` used for
     * cluster-membership matching. Sends are distributed across the servers by
     * health-aware round-robin, preferring ones whose connection is ready.
     *
     * Note that per-entry `username` and `password` are currently ignored — the
     * underlying queues authenticate with the top-level credentials.
     */
    cluster?: IMessageQueueConnection[];

    /**
     * Cluster managers that discover and maintain cluster servers dynamically.
     * Supplying this — or {@link IMQOptions.cluster} — makes {@link IMQ.create}
     * return a {@link ClusteredRedisQueue}.
     *
     * @remarks
     * Each manager implements its own server-detection mechanism;
     * {@link UDPClusterManager} discovers members from UDP broadcasts. Implement
     * {@link ClusterManager} to add your own.
     */
    clusterManagers?: ClusterManager[];

    /**
     * Enable process signal handling (SIGTERM, SIGINT, SIGABRT) by the queue.
     * When enabled, the queue releases its watcher lock on these signals and
     * then exits the process. It does not wait for in-flight `message` handlers
     * to finish, so drain those yourself if work in progress must not be lost.
     * Disable if the host application manages shutdown.
     *
     * @defaultValue true
     *
     * @remarks
     * The handlers are installed once per process, by the first started queue
     * that does not disable them, and they release the watcher locks of every
     * started queue in the process before calling `process.exit(0)` — forced
     * after `IMQ_SHUTDOWN_TIMEOUT` milliseconds, with exit code 1 if a lock could
     * not be released. Because they are process-wide, disabling this on one
     * instance does not prevent exit when another instance leaves it enabled.
     */
    handleSignals?: boolean;

    /**
     * Enables/disables verbose logging.
     *
     * @defaultValue false
     *
     * @remarks
     * Only informational tracing is gated by this. Connection lifecycle messages
     * and internal errors are always written to {@link IMQOptions.logger}.
     */
    verbose?: boolean;

    /**
     * Enables/disables extended verbose logging.
     *
     * @deprecated Never implemented — no code path reads this option, so setting
     * it produces no additional output whatsoever. Use {@link IMQOptions.verbose}
     * instead. Scheduled for removal in the next major.
     */
    verboseExtended?: boolean;
}

/**
 * Typed event map for a queue's `EventEmitter` base, giving compile-time
 * signatures for the only two events a queue emits.
 *
 * @remarks
 * The map is closed, so `emit`/`on` with any other event name is a type error —
 * there is no `connect`, `close`, `ready` or `drain` event on a queue.
 */
export interface EventMap {
    /**
     * Emitted for every message consumed from the queue, with the payload, the
     * message id, and the name of the queue that sent it.
     */
    message: [data: JsonObject, id: string, from: string];
    /**
     * Emitted for background failures, with the error and the name of the
     * internal routine that caught it — a diagnostic label such as `OnMessage`,
     * `OnReadSafe` or `OnWatch`, not an error code.
     *
     * @remarks
     * Emitted only when at least one `error` listener is attached; otherwise the
     * error is logged and swallowed so a background routine cannot crash the
     * process. Errors are always written to {@link IMQOptions.logger} as well,
     * and emission is informational — the queue keeps running.
     */
    error: [error: Error, eventName: string];
}

/**
 * Constructor contract every queue adapter must satisfy: it takes the queue
 * name, optional partial options and an optional {@link IMQMode}, and yields an
 * {@link IMessageQueue}.
 *
 * {@link IMQ.create} resolves an adapter of this shape from the registered
 * vendor adapters and instantiates it.
 *
 * @remarks
 * The built-in adapters are registered through an explicit cast rather than
 * structural assignment, so do not expect a clean assignment from a concrete
 * queue class to this type.
 */
export type IMessageQueueConstructor = new (
    name: string,
    options?: Partial<IMQOptions>,
    mode?: IMQMode,
) => IMessageQueue;

/**
 * Contract every messaging queue implementation fulfils. Implement it to add a
 * transport of your own, or program against it to stay adapter-agnostic.
 *
 * A queue is an `EventEmitter` typed by {@link EventMap}, so it emits exactly two
 * events: `message`, with the payload, the message id and the sending queue's
 * name; and `error`, with the error and the name of the internal routine that
 * caught it. The `error` event fires only when a listener is attached — attach one
 * if background failures must be observed.
 *
 * @example
 * Implementing an adapter:
 * ```typescript
 * import {
 *     type IMessageQueue,
 *     type EventMap,
 *     type JsonObject,
 *     EventEmitter,
 * } from '@imqueue/core';
 * import { randomUUID } from 'node:crypto';
 *
 * class SomeMQAdapter extends EventEmitter<EventMap>
 *     implements IMessageQueue
 * {
 *     public async start(): Promise<SomeMQAdapter> {
 *         // ... implementation goes here
 *         return this;
 *     }
 *     public async stop(): Promise<SomeMQAdapter> {
 *         // ... implementation goes here
 *         return this;
 *     }
 *     public async send(
 *         toQueue: string,
 *         message: JsonObject,
 *         delay?: number,
 *     ): Promise<string> {
 *         const messageId = randomUUID();
 *         // ... implementation goes here
 *         return messageId;
 *     }
 *     public async subscribe(
 *         channel: string,
 *         handler: (data: JsonObject) => void,
 *     ): Promise<void> {
 *         // ... implementation goes here
 *     }
 *     public async unsubscribe(): Promise<void> {
 *         // ... implementation goes here
 *     }
 *     public async publish(
 *         data: JsonObject,
 *         toName?: string,
 *     ): Promise<void> {
 *         // ... implementation goes here
 *     }
 *     public async queueLength(): Promise<number> {
 *         // ... implementation goes here
 *         return 0;
 *     }
 *     public async clear(): Promise<SomeMQAdapter> {
 *         // ... implementation goes here
 *         return this;
 *     }
 *     public async destroy(): Promise<void> {
 *         // ... implementation goes here
 *     }
 * }
 * ```
 */
export interface IMessageQueue extends EventEmitter<EventMap> {
    /**
     * Starts the queue: opens its connections, joins watcher election and begins
     * consuming, so `message` events start arriving.
     *
     * @returns this queue instance
     * @throws TypeError when the queue was constructed without a name
     *
     * @remarks
     * A no-op when the queue is already started, and it may be called again
     * after {@link IMessageQueue.stop}. A reader is opened only in
     * {@link IMQMode.BOTH} or {@link IMQMode.WORKER} mode, so a publisher-only
     * queue never emits `message`. Unless
     * {@link IMQOptions.handleSignals} is disabled, this also installs
     * process-wide signal handlers.
     *
     * Required before {@link IMessageQueue.publish};
     * {@link IMessageQueue.send} starts the queue implicitly.
     */
    start(): Promise<IMessageQueue>;

    /**
     * Stops consuming, so no further `message` events fire.
     *
     * @returns this queue instance
     *
     * @remarks
     * Only the reader is torn down. The writer connection, the watcher lock and
     * the watcher/maintenance timers all stay active, and
     * {@link IMessageQueue.send} and {@link IMessageQueue.publish} keep working —
     * call {@link IMessageQueue.destroy} to release those. Safe to call when not
     * started, and {@link IMessageQueue.start} may be called again afterwards.
     */
    stop(): Promise<IMessageQueue>;

    /**
     * Sends a message to the specified queue with the given data.
     *
     * @param toQueue - name of the destination queue
     * @param message - message data to send
     * @param delay - if specified, the message becomes available in the target
     *        queue only after this many milliseconds. This is a minimum, not a
     *        schedule: the message is released by the watcher, either on a Redis
     *        expired-key notification or on the next
     *        {@link IMQOptions.watcherCheckDelay} poll, so availability may lag
     *        by up to that interval. A delay of `0` or `undefined` sends
     *        immediately.
     * @param errorHandler - callback invoked only when an internal error occurs
     *        during message send execution
     * @returns the identifier assigned to the message
     * @throws TypeError when the queue is in {@link IMQMode.WORKER}-only mode, or
     *         when a writer connection cannot be established
     *
     * @remarks
     * The returned promise resolves as soon as the write has been dispatched —
     * before the queue host confirms it, and long before the message is
     * consumed. The identifier is generated locally, so it is available even if
     * the write later fails. A resolved promise is therefore not evidence that
     * the message was enqueued: supply `errorHandler` to observe write failures,
     * which never reject.
     *
     * Starts the queue implicitly when it has not been started yet. Delivery is
     * at-least-once, so handlers must be idempotent.
     */
    send(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string>;

    /**
     * Subscribes to the pub/sub channel with the given name and registers a
     * handler for the data it delivers. The effective channel is
     * `<prefix>:<channel>`.
     *
     * @param channel - channel name within the queue's prefix namespace
     * @param handler - invoked with the parsed payload of each published message
     * @throws TypeError when no channel name is given, or when a different
     *         channel name is supplied while a subscription is already open — an
     *         instance supports exactly one channel until
     *         {@link IMessageQueue.unsubscribe} resets it
     *
     * @remarks
     * Calling this repeatedly with the same channel name adds another handler
     * rather than replacing the existing one, and all of them are invoked. The
     * subscription uses its own connection, so it does not require
     * {@link IMessageQueue.start}, and it is re-established automatically after a
     * reconnect.
     *
     * Payloads are always plain JSON — {@link IMQOptions.useGzip} does not apply
     * to pub/sub. Delivery is fire-and-forget: messages published while nobody is
     * subscribed are lost, unlike queued messages.
     */
    subscribe(
        channel: string,
        handler: (data: JsonObject) => void,
    ): Promise<void>;

    /**
     * Closes the subscription channel and drops every handler registered through
     * {@link IMessageQueue.subscribe}, resetting the instance so a later
     * subscription may use a different channel name.
     *
     * @remarks
     * A no-op when no subscription exists, and it never rejects — teardown
     * failures are only logged. There is no way to remove an individual handler.
     */
    unsubscribe(): Promise<void>;

    /**
     * Publishes data to the current queue channel
     *
     * If toName is specified, publishes to a pubsub with a different name. This
     * can be used to broadcast messages to other subscribers on different pubsub
     * channels. Different names must be in the same namespace (same imq prefix).
     *
     * @param data - data to publish as a channel message
     * @param toName - optional different pubsub name to publish to
     * @throws TypeError when the queue has no writer connection
     *
     * @remarks
     * Unlike {@link IMessageQueue.send}, this does not start the queue
     * implicitly — {@link IMessageQueue.start} must have completed first. The
     * payload is always plain JSON ({@link IMQOptions.useGzip} does not apply),
     * and pub/sub delivery is not persisted, so subscribers that are not
     * connected at publish time never receive the message.
     */
    publish(data: JsonObject, toName?: string): Promise<void>;

    /**
     * Releases this queue handle: removes all event listeners, stops the
     * maintenance timers, releases the watcher lock if held, disconnects the
     * reader, and drops this instance's reference to the shared writer.
     *
     * @remarks
     * The writer connection is shared per `host:port` within the process and
     * stays open while other started instances still reference it.
     *
     * Queue data is deliberately left intact, so destroying one handle never
     * discards messages still pending for other producers or consumers. Note that
     * removing all listeners also discards the caller's `message` and `error`
     * handlers, while {@link IMessageQueue.start} can revive the instance — so
     * re-register them if you restart it.
     */
    destroy(): Promise<void>;

    /**
     * Deletes this queue's pending messages — both the main list and the delayed
     * set for `<prefix>:<name>`.
     *
     * @returns this queue instance
     *
     * @remarks
     * Other queues in the namespace, the watcher lock, and messages currently
     * leased to a worker under {@link IMQOptions.safeDelivery} are all untouched —
     * a leased message can be re-queued by the watcher once its lease expires, so
     * this does not guarantee the queue stays empty.
     *
     * It never rejects: with no writer connection it silently does nothing, and
     * host failures are logged rather than raised, so success cannot be inferred
     * from a resolved promise.
     */
    clear(): Promise<IMessageQueue>;

    /**
     * Returns the number of messages currently waiting in this queue's main list.
     *
     * @returns count of messages waiting to be consumed
     *
     * @remarks
     * Delayed messages that are not yet due, and messages currently leased to a
     * worker under {@link IMQOptions.safeDelivery}, are not counted — so this
     * is not the amount of outstanding work.
     *
     * Returns `0` when the queue has no writer connection, which makes
     * "disconnected" indistinguishable from "empty".
     */
    queueLength(): Promise<number>;
}
