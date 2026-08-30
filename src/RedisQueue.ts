/*!
 * Fast messaging queue over Redis
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
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
    type IMessageQueue,
    type IRedisClient,
    type JsonObject,
    type IMQOptions,
    type IMessage,
    type ILogger,
    IMQMode,
    type EventMap,
    profile,
} from './index.js';
import {
    buildOptions,
    escapeRegExp,
    randomInt,
    pack,
    sha1,
    unpack,
    envInt,
    errorCode,
    LOG_MAX_KEYS,
} from './helpers/index.js';
import Redis from './redis.js';

const RX_CLIENT_NAME = /name=(\S+)/g;
const RX_CLIENT_TEST = /:(reader|writer|watcher)/;
const RX_CLIENT_CLEAN = /:(reader|writer|watcher).*$/;

/** Base delay (ms) for the exponential reconnection backoff */
const RECONNECT_BASE_DELAY = 1000;

/** Upper cap (ms) for the exponential reconnection backoff */
const RECONNECT_MAX_DELAY = 30000;

/** SCAN batch size used while sweeping keys */
const SCAN_COUNT = '1000';

/**
 * This process, as it appears inside every connection name this queue registers
 * with the broker (see `getChannelName`). Stamped into each worker key so the
 * watcher can ask the broker whether a lease's owner is still alive instead of
 * asking a clock whether time has run out.
 */
const OWNER = `pid:${process.pid}:host:${hostname()}`;

/** Matches the owner inside a worker key, which ends with its deadline */
const RX_LEASE_OWNER = /:(pid:\d+:host:[^:]+):\d+$/;

/** Matches the owner inside a `name=` entry of `CLIENT LIST` */
const RX_CLIENT_OWNER = /(pid:\d+:host:\S+)$/;

/**
 * Upper bound (ms) on the reader's blocking pop. A lease deadline is stamped
 * before the pop that fills the key, so a message is born having already spent
 * whatever the pop waited; capping it keeps that negligible against a budget of
 * minutes.
 */
const READ_MAX_BLOCK = 5000;

/** Redis config parameter holding the keyspace-notification flags */
const NOTIFY_EVENTS_PARAM = 'notify-keyspace-events';

/**
 * Keyspace-notification flags this queue depends on: `E` to receive
 * `__keyevent@<db>__` notifications and `x` for expired-key events. Together
 * they drive delayed-message delivery.
 */
const NOTIFY_EVENTS_REQUIRED = 'Ex';

/**
 * Event classes Redis' `A` shortcut expands to — every class except the
 * `K`/`E` delivery selectors and the special `m`/`n` classes. A server
 * configured with `A` therefore already covers `x`.
 */
const NOTIFY_EVENTS_ALL = 'g$lshzxetd';

/**
 * ioredis retry strategy that disables the built-in reconnection — this
 * queue performs its own capped-backoff reconnection instead.
 */
function noRetryStrategy(): null {
    return null;
}

/**
 * Resolves after the given number of milliseconds.
 *
 * @param ms - number of milliseconds to wait
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default option values applied to every queue instance: `localhost:6379`,
 * prefix `imq`, `console` as the logger, cleanup off with filter `'*'`, safe
 * delivery off with a 5000 ms lease TTL, gzip off, a 5000 ms watcher check
 * interval, and process signal handling on.
 *
 * @remarks
 * Constructor options are shallow-merged over this object, so passing an explicit
 * `undefined` overrides a default rather than falling back to it.
 *
 * The object is exported live and is not frozen — mutating it changes the
 * defaults for every queue constructed afterwards in the process. Prefer
 * per-instance options.
 */
export const DEFAULT_IMQ_OPTIONS: IMQOptions = {
    host: 'localhost',
    port: 6379,
    cleanup: false,
    cleanupFilter: '*',
    logger: console,
    prefix: 'imq',
    safeDelivery: false,
    safeDeliveryTtl: 300000,
    useGzip: false,
    watcherCheckDelay: 5000,
    handleSignals: true,
};

/**
 * Time in milliseconds allowed for releasing watcher locks when a shutdown
 * signal is received, before the process is force-exited. Defaults to 1000;
 * override with the `IMQ_SHUTDOWN_TIMEOUT` environment variable.
 *
 * @remarks
 * This is not a drain period — running `message` handlers are not awaited.
 * The value is read once when the module is loaded, and a non-numeric value falls
 * back to the default. Relevant only while {@link IMQOptions.handleSignals} is
 * enabled.
 */
export const IMQ_SHUTDOWN_TIMEOUT = envInt('IMQ_SHUTDOWN_TIMEOUT', 1000);

/**
 * Grace period (ms) for a graceful QUIT to complete before a channel is
 * forcibly disconnected. A reader blocked on an infinite BRPOP/BLMOVE can
 * never let QUIT through, so without this the socket would leak and keep
 * the process alive.
 *
 * @remarks
 * Defaults to 1000; override with the `IMQ_CONNECTION_QUIT_TIMEOUT` environment
 * variable, which is read once when the module is loaded. Applies to the writer,
 * watcher and subscription channels — the reader is disconnected immediately
 * without attempting `QUIT`.
 */
export const IMQ_CONNECTION_QUIT_TIMEOUT = envInt(
    'IMQ_CONNECTION_QUIT_TIMEOUT',
    1000,
);

type RedisConnectionChannel = 'reader' | 'writer' | 'watcher' | 'subscription';

const IMQ_REDIS_MAX_LISTENERS_LIMIT = envInt(
    'IMQ_REDIS_MAX_LISTENERS_LIMIT',
    10000,
);

/**
 * Redis-backed message queue with at-least-once delivery — the default
 * {@link IMessageQueue} implementation, and what {@link IMQ.create} returns for a
 * single-server configuration.
 *
 * @remarks
 * Connection model: the reader is per instance and exists only in
 * {@link IMQMode.BOTH} or {@link IMQMode.WORKER} mode, while the writer and
 * watcher connections are shared per `host:port` across every queue in the
 * process and reference-counted. Exactly one queue per key prefix is elected as
 * the watcher through a `<prefix>:watch:lock` key, and that owner also releases
 * delayed messages, recovers abandoned safe-delivery hand-offs and — when
 * {@link IMQOptions.cleanup} is on — prunes orphaned keys.
 *
 * Lifecycle: {@link RedisQueue.start} is required before consuming or
 * publishing, while {@link RedisQueue.send} starts the queue lazily.
 * {@link RedisQueue.stop} only stops consuming; use
 * {@link RedisQueue.destroy} to release the watcher lock, the timers and the
 * connections.
 *
 * Reconnection is handled by the queue itself — ioredis's own retry strategy is
 * disabled in favour of a capped exponential backoff from 1 s to 30 s per
 * channel.
 *
 * Events (typed by {@link EventMap}): `message`, with the payload, the message id
 * and the sending queue's name; and `error`, with the error and the name of the
 * internal routine that caught it (`OnMessage`, `OnProcessDelayed`,
 * `OnSafeDelivery`, `OnWatch`, `OnConfig`, `OnScriptLoad`, `OnReadUnsafe` or
 * `OnReadSafe`). Background errors are emitted only when at least one `error`
 * listener is attached — otherwise they are logged and swallowed, so attach one
 * if you need to observe them.
 */
export class RedisQueue
    extends EventEmitter<EventMap>
    implements IMessageQueue
{
    /**
     * Writer connections collection
     */
    private static writers: { [key: string]: IRedisClient } = {};

    /**
     * Watcher connections collection
     */
    private static watchers: { [key: string]: IRedisClient } = {};

    /**
     * Number of started queue instances per shared writer connection key
     */
    private static writerRefs: { [key: string]: number } = {};

    /**
     * All started queue instances within the current process
     */
    private static readonly instances: Set<RedisQueue> = new Set();

    /**
     * True when process-level signal handlers were bound
     */
    private static signalsBound: boolean = false;

    /**
     * The effective options for this queue: {@link DEFAULT_IMQ_OPTIONS} merged
     * with the values passed to the constructor.
     *
     * @remarks
     * Treat this as read-only configuration. Some options are captured at
     * construction time — `useGzip`, `host` and `port` — so changing them here has
     * no effect, while `safeDelivery`, `safeDeliveryTtl`, `cleanup`,
     * `cleanupFilter` and `verbose` are re-read at runtime.
     */
    public options: IMQOptions;

    /**
     * Reader connection associated with this queue instance
     */
    private reader?: IRedisClient;

    /**
     * Channel connection associated with this queue instance
     * Specially designed for client subscriptions to server-emitted events
     */
    private subscription?: IRedisClient;

    /**
     * Channel name for subscriptions
     */
    private subscriptionName?: string;

    /**
     * Init state for this queue instance
     */
    private initialized: boolean = false;

    /**
     * Signals if the queue was destroyed
     */
    private destroyed: boolean = false;

    /**
     * True if the current instance owns a watcher connection, false otherwise
     */
    private watchOwner: boolean = false;

    /**
     * Subscription handlers registered through subscribe(). Kept to be
     * able to restore the subscription after a connection replacement.
     */
    private subscriptionHandlers: Array<(data: JsonObject) => void> = [];

    /**
     * Will store check interval reference
     */
    private safeCheckInterval?: NodeJS.Timeout;

    /**
     * Periodic watcher existence check interval reference
     */
    private watcherCheckInterval?: NodeJS.Timeout;

    /**
     * Guards overlapping watcher check runs
     */
    private watcherCheckBusy: boolean = false;

    /**
     * Number of rejected writes in the current failure episode of this
     * instance's writer, zero while writes succeed. The first rejection of an
     * episode is logged, the rest only counted, and the first successful
     * write logs the recovery together with this count.
     */
    private rejectedWrites: number = 0;

    /**
     * Channels a publish currently finds no subscribers on, so that the
     * condition is reported on entry only and not on every publish. Bounded
     * by {@link LOG_MAX_KEYS}: channel names may arrive as unique values, so
     * names above the bound are not remembered and their publishes are
     * reported every time.
     */
    private readonly noSubscribers: Set<string> = new Set();

    /**
     * Connected client keys seen during the previous cleanup sweep. Used
     * to give temporarily disconnected clients one sweep of grace before
     * removing their keys.
     */
    private lastConnectedKeys: string[] = [];
    /** Lease owners seen connected on the previous sweep (one sweep of grace) */
    private lastOwners: Set<string> = new Set<string>();

    /**
     * True while this instance holds a reference to the shared writer
     */
    private writerAcquired: boolean = false;

    /**
     * Internal per-channel reconnection state
     */
    private reconnectTimers: Partial<
        Record<RedisConnectionChannel, NodeJS.Timeout>
    > = {};
    /**
     * Consecutive failed reconnection attempts per channel, which is what the
     * backoff delay is computed from. Reset once a channel connects again.
     */
    private reconnectAttempts: Partial<Record<RedisConnectionChannel, number>> =
        {};
    /**
     * Channels with a reconnection already in progress.
     *
     * @remarks
     * A guard, not a status: several `close` events can arrive for one channel,
     * and without this each would start its own reconnection loop.
     */
    private reconnecting: Partial<Record<RedisConnectionChannel, boolean>> = {};

    /**
     * The `host:port` address of the redis server this queue talks to.
     *
     * @remarks
     * This is not an instance identifier. It is deliberately shared by every
     * queue in the process that targets the same server, and is the key under
     * which the writer and watcher connections (and the writer reference count)
     * are stored. It includes neither the key prefix nor the credentials, so two
     * queues differing only in those share the same underlying connections — the
     * first one created wins.
     */
    public readonly redisKey: string;

    /**
     * Lua scripts for redis
     */
    private scripts: { [name: string]: { code: string; checksum?: string } } = {
        moveDelayed: {
            code: `
                local messages = redis.call(
                    "zrangebyscore", KEYS[1], "-inf", ARGV[1])
                local count = table.getn(messages)
                local message
                local i = 1
                if count > 0 then
                    while messages[i] do
                        redis.call("lpush", KEYS[2], messages[i])
                        i = i + 1
                    end
                    redis.call("zremrangebyscore", KEYS[1],
                        "-inf", ARGV[1])
                end
                return count
            `,
        },
    };

    /**
     * Serializes a given data object into string
     *
     * @param data - the value to serialize; must be JSON-serializable
     * @returns the wire representation, gzipped when
     *          {@link IMQOptions.useGzip} is on
     */
    private readonly pack: (data: unknown) => string;

    /**
     * Deserialize string data into an object
     *
     * @param data - the wire representation, as produced by `pack`
     * @returns the deserialized value
     * @throws when the payload is malformed, or was packed with a different
     *         {@link IMQOptions.useGzip} setting
     */
    private readonly unpack: (data: string) => unknown;

    /**
     * Creates a queue handle. No connection is opened here — call
     * {@link RedisQueue.start}, or {@link RedisQueue.send}, which starts the
     * queue implicitly.
     *
     * @param name - queue name; the underlying Redis list key becomes
     *        `<prefix>:<name>`
     * @param options - partial options merged over {@link DEFAULT_IMQ_OPTIONS}
     * @param mode - whether this handle produces, consumes, or both; defaults to
     *        {@link IMQMode.BOTH}
     *
     * @remarks
     * The constructor performs no I/O. It resolves the effective options, selects
     * the serializer pair from {@link IMQOptions.useGzip} once, and derives
     * the `host:port` key under which the shared connections are stored — so
     * changing `useGzip`, `host` or `port` on `options` afterwards has no effect.
     */
    public constructor(
        /**
         * The queue name. The underlying redis list key is `<prefix>:<name>`, the
         * same name is the default pub/sub channel used by
         * {@link RedisQueue.publish}, and it is the `from` value carried by
         * messages this queue sends.
         *
         * @remarks
         * Assign it before {@link RedisQueue.start} — a running reader keeps
         * consuming the key it was started with.
         */
        public name: string,
        options?: Partial<IMQOptions>,
        /**
         * Whether this handle publishes, consumes, or both.
         *
         * @remarks
         * Fixed at construction: it decides which connections `start()` opens,
         * so a publisher never opens a reader and cannot consume even by
         * accident.
         */
        private readonly mode: IMQMode = IMQMode.BOTH,
    ) {
        super();

        this.options = buildOptions<IMQOptions>(DEFAULT_IMQ_OPTIONS, options);

        this.pack = this.options.useGzip ? pack : JSON.stringify;
        this.unpack = this.options.useGzip ? unpack : JSON.parse;
        this.redisKey = `${this.options.host}:${this.options.port}`;

        for (const script of Object.keys(this.scripts)) {
            this.scripts[script].checksum = sha1(this.scripts[script].code);
        }

        this.verbose(
            `Initializing queue on ${this.options.host}:${
                this.options.port
            } with prefix ${this.options.prefix} and safeDelivery = ${
                this.options.safeDelivery
            }, and safeDeliveryTtl = ${
                this.options.safeDeliveryTtl
            }, and watcherCheckDelay = ${
                this.options.watcherCheckDelay
            }, and useGzip = ${this.options.useGzip}`,
        );
    }

    /**
     * Writes a diagnostic line, but only under {@link IMQOptions.verbose}.
     *
     * @param message - the line to write, tagged with this queue's name
     *
     * @remarks
     * For tracing the queue's own lifecycle. Anything a user must see whether
     * or not verbose is on goes through `logLine` instead.
     */
    private verbose(message: string): void {
        if (this.options.verbose) {
            this.logger.info(`[IMQ-CORE][${this.name}]: ${message}`);
        }
    }

    /**
     * Writes an unconditional line through this queue's logger, in the format
     * `verbose()` uses.
     *
     * @param level - logger method to write the line with
     * @param message - the line, which must never carry message payload,
     *        call arguments, raw redis keys or an error text
     *
     * @remarks
     * Never throws: a broken logger must not be able to change what the queue
     * does.
     */
    private logLine(level: 'info' | 'warn' | 'error', message: string): void {
        try {
            this.logger[level](`[IMQ-CORE][${this.name}]: ${message}`);
        } catch {
            // a failing logger must never influence queue behaviour
        }
    }

    /**
     * Records one logical rejected write of this instance's writer: the first
     * rejection of a failure episode writes the given line, every following
     * one only increments the episode counter, and the counter is reported by
     * {@link RedisQueue.recordWriteSuccess} when a write succeeds again.
     *
     * @param message - the line, under the same constraints as
     *        {@link RedisQueue.logLine}
     */
    private recordWriteFailure(message: string): void {
        this.rejectedWrites++;

        if (this.rejectedWrites === 1) {
            this.logLine('error', message);
        }
    }

    /**
     * Closes the current write-failure episode, if one is open: reports how
     * many writes were rejected in it and resets the counter. The counter is
     * reset before the logger is touched, so a broken logger cannot keep the
     * episode open forever.
     */
    private recordWriteSuccess(): void {
        if (this.rejectedWrites === 0) {
            return;
        }

        const rejected = this.rejectedWrites;

        this.rejectedWrites = 0;
        this.logLine(
            'info',
            `outbound writes resumed after ${rejected} rejected writes`,
        );
    }

    /**
     * Creates a subscription channel over redis and sets up channel
     * data read handler. The effective Redis channel is `<prefix>:<channel>`.
     *
     * @param channel - channel name within this queue's prefix namespace
     * @param handler - invoked with the parsed payload of each published message
     * @throws TypeError when no channel name is given, or when a different
     *         channel name is supplied while a subscription is already open — an
     *         instance supports exactly one channel until
     *         {@link RedisQueue.unsubscribe} resets it
     *
     * @remarks
     * Calling this again with the same channel adds another handler rather than
     * replacing the existing one, and every handler is invoked for each message.
     *
     * A dedicated subscription connection is created on demand, so
     * {@link RedisQueue.start} is not required, and the subscription is
     * re-established automatically after a reconnect.
     *
     * Payloads are parsed as plain JSON ({@link IMQOptions.useGzip} does not
     * apply to pub/sub). Neither a parse error nor an exception thrown by the
     * handler is contained by the queue, so handlers should not throw.
     */
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => void,
    ): Promise<void> {
        if (!channel) {
            throw new TypeError(
                `${channel}: No subscription channel name provided!`,
            );
        }

        if (this.subscriptionName && this.subscriptionName !== channel) {
            throw new TypeError(
                `Invalid channel name provided: expected "${
                    this.subscriptionName
                }", but "${channel}" given instead!`,
            );
        } else if (!this.subscriptionName) {
            this.subscriptionName = channel;
        }

        const fcn = `${this.options.prefix}:${this.subscriptionName}`;
        const chan = await this.connect('subscription', this.options);

        await chan.subscribe(fcn);
        this.attachSubscriptionHandler(chan, handler);
        this.subscriptionHandlers.push(handler);

        this.verbose(`Subscribed to ${channel} channel`);
        // a lifecycle fact, not an alarm: flow continuation hangs on this
        // subscription, so its absence after a reconnect must be provable
        this.logLine('info', `subscribed to channel ${channel}`);
    }

    /**
     * Attaches a subscription message handler to a given channel
     * connection
     *
     * @param chan - the pub/sub channel to deliver messages from
     * @param handler - called with the decoded payload of each message
     */
    private attachSubscriptionHandler(
        chan: IRedisClient,
        handler: (data: JsonObject) => void,
    ): void {
        const fcn = `${this.options.prefix}:${this.subscriptionName}`;

        chan.on('message', (ch: string, message: string) => {
            if (ch === fcn && typeof handler === 'function') {
                handler(JSON.parse(message) as JsonObject);
            }

            this.verbose(
                `Received message from ${ch} channel, data: ${JSON.stringify(
                    message,
                )}`,
            );
        });
    }

    /**
     * Restores the subscription state on a freshly created subscription
     * connection. Used after a connection replacement on reconnection,
     * otherwise the new connection would silently stay unsubscribed.
     */
    private async restoreSubscription(): Promise<void> {
        const chan = this.subscription;

        if (
            !chan ||
            !this.subscriptionName ||
            !this.subscriptionHandlers.length
        ) {
            return;
        }

        const fcn = `${this.options.prefix}:${this.subscriptionName}`;

        await chan.subscribe(fcn);

        for (const handler of this.subscriptionHandlers) {
            this.attachSubscriptionHandler(chan, handler);
        }

        this.verbose(`Restored subscription to ${this.subscriptionName}`);
        this.logLine(
            'info',
            `restored subscription to channel ${this.subscriptionName}`,
        );
    }

    /**
     * Closes the subscription connection and forgets the channel name together
     * with every handler registered through {@link RedisQueue.subscribe}.
     *
     * @remarks
     * A later {@link RedisQueue.subscribe} must register its handlers again, and
     * may use a different channel name. A no-op when the queue was never
     * subscribed, and it never rejects — failures during unsubscribe are logged
     * only. Called automatically by {@link RedisQueue.destroy}.
     */
    public async unsubscribe(): Promise<void> {
        if (this.subscription) {
            this.verbose('Initialize unsubscribing...');

            try {
                if (this.subscriptionName) {
                    await this.subscription.unsubscribe(
                        `${this.options.prefix}:${this.subscriptionName}`,
                    );

                    this.verbose(
                        `Unsubscribed from ${this.subscriptionName} channel`,
                    );
                }

                this.subscription.removeAllListeners();
                await this.subscription.quit().catch(error => {
                    this.verbose(`Unsubscribe quit error: ${error}`);
                });
                this.subscription.disconnect(false);
            } catch (error) {
                this.verbose(`Unsubscribe error: ${error}`);
            }
        }

        this.subscriptionName = undefined;
        this.subscription = undefined;
        this.subscriptionHandlers = [];
    }

    /**
     * Publishes a message to this queue subscription channel for currently
     * subscribed clients.
     *
     * If toName specified will publish to PubSub with a different name. This
     * can be used to implement broadcasting some messages to other subscribers
     * on other PubSub channels.
     *
     * @param data - payload to publish as a channel message
     * @param toName - optional different pub/sub name to publish to; must be a
     *        bare name inside the same prefix namespace, not a full Redis channel
     *        key
     * @throws TypeError when the queue has no writer connection
     *
     * @remarks
     * Unlike {@link RedisQueue.send}, this does not start the queue
     * implicitly, so {@link RedisQueue.start} must have completed first. It is
     * allowed in any {@link IMQMode}, including `WORKER`.
     *
     * The payload is always plain JSON — {@link IMQOptions.useGzip} applies to
     * queue messages only. Redis pub/sub drops the message when nobody is
     * subscribed; on entering that state the queue writes a warning through
     * its logger, so the drop is no longer silent.
     */
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        if (!this.writer) {
            throw new TypeError('Writer is not connected!');
        }

        const jsonData = JSON.stringify(data);
        const name = toName || this.name;

        const receivers = await this.writer.publish(
            `${this.options.prefix}:${name}`,
            jsonData,
        );

        // redis replies with the number of subscribers which received the
        // event: zero means nobody did, and events are how a consumer learns
        // to continue its work. Reported on entering the state only, and only
        // on a strict zero - a client whose reply is not a number is left
        // alone rather than coerced, so reading it can neither throw nor
        // invent a warning
        if (receivers === 0) {
            if (!this.noSubscribers.has(name)) {
                if (this.noSubscribers.size < LOG_MAX_KEYS) {
                    this.noSubscribers.add(name);
                }

                this.logLine(
                    'warn',
                    `published to channel ${name} on host ${
                        this.redisKey
                    } with no subscribers`,
                );
            }
        } else {
            this.noSubscribers.delete(name);
        }

        this.verbose(`Published message to ${name} channel, data: ${jsonData}
        `);
    }

    /**
     * Initializes and starts current queue routines: opens the writer (and, in
     * {@link IMQMode.BOTH} or {@link IMQMode.WORKER} mode, the reader), joins
     * watcher election and starts the periodic watcher check.
     *
     * @returns this queue instance
     * @throws TypeError when the queue was constructed without a name
     *
     * @remarks
     * Idempotent — a second call on a started queue resolves immediately — and
     * the queue can be restarted after {@link RedisQueue.stop}.
     *
     * Unless {@link IMQOptions.handleSignals} is false, this installs
     * process-level SIGTERM/SIGINT/SIGABRT handlers that release watcher locks
     * and then exit the process without waiting for in-flight handlers.
     *
     * If watcher initialization fails the returned promise rejects, but the
     * writer connection, the instance registration and any acquired watcher lock
     * remain in place — call {@link RedisQueue.destroy} to clean up after a
     * failed start.
     */
    public async start(): Promise<RedisQueue> {
        if (!this.name) {
            throw new TypeError(`${this.name}: No queue name provided!`);
        }

        if (this.initialized) {
            return this;
        }

        this.destroyed = false;

        const connPromises = [];

        if (!this.reader && this.isWorker()) {
            this.verbose('Initializing reader...');
            connPromises.push(this.connect('reader', this.options));
        }

        if (!this.writer) {
            this.verbose('Initializing writer...');
            connPromises.push(this.connect('writer', this.options));
        }

        await Promise.all(connPromises);

        this.verbose('Connections initialized');

        RedisQueue.instances.add(this);

        if (this.options.handleSignals !== false) {
            RedisQueue.bindSignals();
        }

        if (!this.writerAcquired) {
            RedisQueue.writerRefs[this.redisKey] =
                (RedisQueue.writerRefs[this.redisKey] || 0) + 1;
            this.writerAcquired = true;
        }

        await this.initWatcher();
        this.startWatcherCheck();
        this.initialized = true;

        return this;
    }

    /**
     * Binds process-level signal handlers once per process. On shutdown
     * signals, frees watcher locks held by any queue instance and exits.
     */
    private static bindSignals(): void {
        if (RedisQueue.signalsBound) {
            return;
        }

        RedisQueue.signalsBound = true;

        const free = (): void => {
            void RedisQueue.freeAndExit();
        };

        process.on('SIGTERM', free);
        process.on('SIGINT', free);
        process.on('SIGABRT', free);
    }

    /**
     * Frees watcher locks held by all started queue instances and exits
     * the process, forcing exit after IMQ_SHUTDOWN_TIMEOUT at the latest.
     */
    private static async freeAndExit(): Promise<void> {
        let exitCode = 0;
        const timer = setTimeout(() => {
            process.exit(exitCode || 1);
        }, IMQ_SHUTDOWN_TIMEOUT);

        await Promise.all(
            [...RedisQueue.instances]
                .filter(queue => queue.watchOwner)
                .map(queue =>
                    queue.unlock().catch(err => {
                        queue.logger.error(err);
                        exitCode = 1;
                    }),
                ),
        );

        clearTimeout(timer);
        process.exit(exitCode);
    }

    /**
     * Starts a periodic check ensuring a watcher connection exists across
     * the queue network, re-electing an owner when the previous one died.
     * Also serves as a polling fallback moving due to delayed messages when
     * keyspace notifications are unavailable.
     */
    private startWatcherCheck(): void {
        if (this.watcherCheckInterval || !this.options.watcherCheckDelay) {
            return;
        }

        this.watcherCheckInterval = setInterval(
            this.runWatcherCheck.bind(this),
            this.options.watcherCheckDelay,
        );
        this.watcherCheckInterval.unref();
    }

    /**
     * A single watcher-existence check tick: re-elects a watcher owner when
     * none exists and moves due to delayed messages as a keyspace-notification
     * fallback. Errors are contained so the interval never crashes.
     */
    private async runWatcherCheck(): Promise<void> {
        if (this.watcherCheckBusy || this.destroyed || !this.writer) {
            return;
        }

        this.watcherCheckBusy = true;

        try {
            let watchers: number;

            try {
                watchers = await this.watcherCount();
            } catch (err) {
                // the only silent failure of this tick: initWatcher() and
                // processDelayed() log their own errors unconditionally, so
                // wrapping the whole body would just duplicate them. The
                // value is re-thrown, leaving control flow as it was
                // bounded by watcherCheckDelay: this tick runs on an
                // interval, so a persistent failure repeats at that pace
                const code = errorCode(err);

                this.logLine('warn', `watcher check failed, code ${code}`);

                throw err;
            }

            if (!watchers) {
                await this.initWatcher();
            }

            if (this.isWorker()) {
                await this.processDelayed(this.key);
            }
        } catch (err) {
            this.verbose(`Watcher check error: ${err}`);
        } finally {
            this.watcherCheckBusy = false;
        }
    }

    /**
     * Stops the periodic watcher check
     */
    private stopWatcherCheck(): void {
        if (this.watcherCheckInterval) {
            clearInterval(this.watcherCheckInterval);
            this.watcherCheckInterval = undefined;
        }
    }

    /**
     * Sends a given message to a given queue (by name).
     *
     * @param toQueue - name of the destination queue
     * @param message - message payload; must be a JSON object
     * @param delay - if specified, the message becomes available in the target
     *        queue only after this many milliseconds. This is a minimum, not a
     *        schedule — the message is released by the watcher, so availability
     *        may lag by up to {@link IMQOptions.watcherCheckDelay}. A delay of
     *        `0` or `undefined` sends immediately.
     * @param errorHandler - invoked when the write to Redis fails; the returned
     *        promise does not reject for it, so this is the only programmatic
     *        way to observe such a failure. The failure is also reported
     *        through the queue's logger: the first rejected write of a failure
     *        episode is logged, the rest are counted, and the first successful
     *        write logs the recovery with that count
     * @returns the identifier assigned to the message. It is generated locally
     *          before the write is issued, so it is available even if the write
     *          later fails.
     * @throws TypeError when the queue is in {@link IMQMode.WORKER}-only mode, or
     *         when a writer connection cannot be established
     *
     * @remarks
     * The returned promise resolves as soon as the write has been dispatched —
     * the Redis reply is not awaited — so a resolved promise is not evidence that
     * the message was enqueued.
     *
     * Starts the queue implicitly when it has not been started yet, which has
     * process-wide side effects: it may install signal handlers and make this
     * instance the watcher owner.
     */
    public async send(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string> {
        if (!this.isPublisher()) {
            throw new TypeError('IMQ: Unable to publish in WORKER only mode!');
        }

        if (!this.writer) {
            await this.start();
        }

        if (!this.writer) {
            throw new TypeError('IMQ: unable to initialize queue!');
        }

        const id = randomUUID();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;
        const packet = this.pack(data);
        const countedOps = new Set<string>();
        const onWriteError = (error: unknown, op: string): void => {
            if (error) {
                this.verbose(`Writer ${op} error: ${error}`);

                // the caller already holds the message id and gets no
                // rejection, so without this line a rejected write is
                // observable through errorHandler only - and most callers
                // pass none. A client may deliver the same failure through
                // both its callback and its returned promise: the episode
                // counts each logical failure once, while errorHandler keeps
                // being invoked per delivery, exactly as it always was
                if (!countedOps.has(op)) {
                    countedOps.add(op);
                    this.recordWriteFailure(
                        `write to queue ${toQueue} rejected on ${op}, ` +
                            `message ${id}, code ${errorCode(error)}`,
                    );
                }

                if (errorHandler) {
                    errorHandler(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
            }
        };

        if (delay) {
            this.writer.zadd(
                `${key}:delayed`,
                Date.now() + delay,
                packet,
                (err?: Error | null) => {
                    if (err) {
                        onWriteError(err, 'ZADD');

                        return;
                    }

                    this.writer
                        .set(
                            `${key}:${id}:ttl`,
                            '',
                            'PX',
                            delay,
                            'NX',
                            (err?: Error | null) => {
                                if (err) {
                                    onWriteError(err, 'SET');

                                    return;
                                }

                                // a delayed send is complete only after both
                                // ZADD and SET succeeded, so the episode is
                                // closed here and not on the ZADD alone
                                this.recordWriteSuccess();
                            },
                        )
                        .catch((err: unknown) => onWriteError(err, 'SET'));
                },
            );
        } else {
            const result = this.writer.lpush(
                key,
                packet,
                (err?: Error | null) => {
                    if (err) {
                        onWriteError(err, 'LPUSH');
                    } else {
                        this.recordWriteSuccess();
                    }
                },
            );

            // guard against unhandled rejections from promise-returning
            // client implementations in fire-and-forget mode
            if (result && typeof result.catch === 'function') {
                result.catch((err: unknown) => onWriteError(err, 'LPUSH'));
            }
        }

        return id;
    }

    /**
     * Stops consuming messages by tearing down this instance's reader
     * connection.
     *
     * @returns this queue instance
     *
     * @remarks
     * The queue remains usable as a producer: the shared writer, any held watcher
     * lock, the watcher-check and maintenance intervals, the subscription
     * connection and the process signal handlers all stay in place, and
     * {@link RedisQueue.start} can resume consumption. Use
     * {@link RedisQueue.destroy} to release resources — an instance that is only
     * stopped stays registered in a process-wide registry and is not
     * garbage-collected.
     *
     * The reader socket is dropped immediately rather than closed with a graceful
     * `QUIT`, so Redis stops treating it as a consumer at once and cannot hand it
     * a message the torn-down read loop would drop.
     */
    @profile()
    public async stop(): Promise<RedisQueue> {
        this.verbose('Stopping queue...');

        if (this.reader) {
            this.verbose('Destroying reader...');
            this.destroyChannel('reader');

            delete this.reader;
        }

        this.initialized = false;

        this.verbose('Queue stopped!');

        return this;
    }

    /**
     * Gracefully destroys this queue handle. Does not remove queue data
     * from redis unless clearData is explicitly set to true, so that
     * destroying one handle (e.g., on scale-down) never wipes messages
     * still pending for other producers/consumers.
     *
     * @param clearData - when true, also clears queue data
     *
     * @remarks
     * The writer connection is shared per `host:port` and reference-counted, so
     * it stays open while another started instance in the process still uses it.
     *
     * All event listeners are removed, including the caller's `message` and
     * `error` handlers — and because {@link RedisQueue.start} can revive the
     * instance, re-register them if you restart it or messages will be consumed
     * and silently discarded.
     *
     * With `clearData` set, only the main and delayed keys are removed: messages
     * currently checked out to a worker key under
     * {@link IMQOptions.safeDelivery} are not, and the watcher returns them to
     * the queue once their worker is gone or their
     * {@link IMQOptions.safeDeliveryTtl} is spent — so messages can reappear
     * after a clearing destroy.
     *
     * Never rejects; unlock and clear failures are logged.
     */
    @profile()
    public async destroy(clearData: boolean = false): Promise<void> {
        this.verbose('Destroying queue...');
        this.destroyed = true;
        RedisQueue.instances.delete(this);
        this.removeAllListeners();
        this.cleanSafeCheckInterval();
        this.stopWatcherCheck();

        if (this.watchOwner) {
            await this.unlock().catch(err =>
                this.verbose(`Unlock error: ${err}`),
            );
            this.destroyWatcher();
            this.watchOwner = false;
        }

        await this.stop();

        if (clearData) {
            await this.clear();
        }

        this.destroyWriter();
        await this.unsubscribe();
        this.verbose('Queue destroyed!');
    }

    /**
     * Deletes this queue's message list and its delayed-message set from redis.
     *
     * @returns this queue instance
     *
     * @remarks
     * A no-op that resolves successfully when the queue has no writer connection.
     * In-flight messages held in worker keys under
     * {@link IMQOptions.safeDelivery} are not removed, and the watcher returns
     * them to the queue once their worker is gone or their
     * {@link IMQOptions.safeDeliveryTtl} is spent — so this does not guarantee
     * the queue stays empty. Errors are logged rather than thrown, so success cannot be
     * inferred from a resolved promise.
     */
    @profile()
    public async clear(): Promise<RedisQueue> {
        if (!this.writer) {
            return this;
        }

        try {
            this.verbose('Clearing expired queue keys...');

            await Promise.all([
                this.writer.del(this.key),
                this.writer.del(`${this.key}:delayed`),
            ]);

            this.verbose('Expired queue keys cleared!');
        } catch (err) {
            if (this.initialized) {
                this.logger.error(
                    `${this.name}: error clearing the redis queue host ${
                        this.redisKey
                    } on writer, pid ${process.pid}:`,
                    err,
                );
            }
        }

        return this;
    }

    /**
     * Returns the number of messages currently waiting in this queue's main list.
     *
     * @returns count of messages waiting to be consumed
     *
     * @remarks
     * Delayed messages that are not yet due, and messages currently checked out
     * to a worker under {@link IMQOptions.safeDelivery}, are not counted — so
     * this is not the amount of outstanding work. Under safe delivery a message
     * is checked out for as long as its handler runs, so on a busy queue the
     * shortfall is roughly everything in flight, not a rounding error.
     *
     * Returns `0` when the queue has no writer connection, which makes
     * "disconnected" indistinguishable from "empty"; it never throws.
     */
    @profile()
    public async queueLength(): Promise<number> {
        if (!this.writer) {
            return 0;
        }

        return this.writer.llen(this.key);
    }

    /**
     * Returns true if publisher mode is enabled on this queue, false otherwise.
     */
    public isPublisher(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.PUBLISHER;
    }

    /**
     * Returns true if worker mode is enabled on this queue, false otherwise.
     */
    public isWorker(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.WORKER;
    }

    /**
     * Returns false only when this queue is known to be unable to accept
     * writes right now — i.e., it has a writer connection currently
     * in a non-ready (reconnecting/closed) state. A queue that has not yet
     * connected is considered available, since sending connects it lazily.
     * Used for health-aware routing in the clustered queue.
     *
     * @remarks
     * The writer connection is shared per `host:port` within the process, so this
     * reflects the health of that server connection rather than of this instance
     * alone — every queue pointing at the same server reports the same value.
     */
    public get available(): boolean {
        return !this.writer || this.writer.status === 'ready';
    }

    /**
     * Writer connection associated with this queue instance. Shared by every
     * queue in the process that targets the same `host:port`.
     */
    private get writer(): IRedisClient {
        return RedisQueue.writers[this.redisKey];
    }

    private set writer(conn: IRedisClient) {
        RedisQueue.writers[this.redisKey] = conn;
    }

    /**
     * Watcher connection associated with this queue instance. Shared by every
     * queue in the process that targets the same `host:port`; at most one queue
     * per prefix is the elected watcher owner.
     */
    private get watcher(): IRedisClient {
        return RedisQueue.watchers[this.redisKey];
    }

    private set watcher(conn: IRedisClient) {
        RedisQueue.watchers[this.redisKey] = conn;
    }

    /**
     * Returns the connection currently bound to the given channel, if any.
     *
     * @param channel - which of the queue's connections to look up
     * @returns the connection, or `undefined` when that channel is not open
     */
    private connectionOf(
        channel: RedisConnectionChannel,
    ): IRedisClient | undefined {
        switch (channel) {
            case 'reader':
                return this.reader;
            case 'writer':
                return this.writer;
            case 'watcher':
                return this.watcher;
            case 'subscription':
                return this.subscription;
        }
    }

    /**
     * Binds the given connection to the given channel.
     *
     * @param channel - which of the queue's connections to bind
     * @param conn - the client to bind, or `undefined` to unbind it
     */
    private bindConnection(
        channel: RedisConnectionChannel,
        conn: IRedisClient,
    ): void {
        switch (channel) {
            case 'reader':
                this.reader = conn;
                break;
            case 'writer':
                this.writer = conn;
                break;
            case 'watcher':
                this.watcher = conn;
                break;
            case 'subscription':
                this.subscription = conn;
                break;
        }
    }

    /**
     * Logger instance associated with the current queue instance
     */
    private get logger(): ILogger {
        return this.options.logger || console;
    }

    /**
     * Return a lock key for watcher connection
     */
    private get lockKey(): string {
        return `${this.options.prefix}:watch:lock`;
    }

    /**
     * Returns current queue key
     */
    private get key(): string {
        return `${this.options.prefix}:${this.name}`;
    }

    /**
     * Destroys watcher channel
     */
    @profile()
    private destroyWatcher(): void {
        if (this.watcher) {
            this.verbose('Destroying watcher...');
            this.destroyChannel('watcher');
            delete RedisQueue.watchers[this.redisKey];
            this.verbose('Watcher destroyed!');
        }
    }

    /**
     * Destroys writer channel
     */
    @profile()
    private destroyWriter(release: boolean = true): void {
        if (release && this.writerAcquired) {
            this.writerAcquired = false;
            RedisQueue.writerRefs[this.redisKey] = Math.max(
                0,
                (RedisQueue.writerRefs[this.redisKey] || 1) - 1,
            );

            if (RedisQueue.writerRefs[this.redisKey] > 0) {
                // the shared writer connection is still used by other
                // queue instances within this process
                this.verbose('Writer is still in use, skipping destroy...');

                return;
            }
        }

        if (this.writer) {
            this.verbose('Destroying writer...');
            this.destroyChannel('writer');
            delete RedisQueue.writers[this.redisKey];
            this.verbose('Writer destroyed!');
        }
    }

    /**
     * Destroys any channel
     */
    @profile()
    private destroyChannel(channel: RedisConnectionChannel): void {
        const client = this.connectionOf(channel);

        if (!client) {
            return;
        }

        try {
            client.removeAllListeners();

            let disconnected = false;
            const forceDisconnect = (): void => {
                if (disconnected) {
                    return;
                }

                disconnected = true;

                try {
                    client.disconnect(false);
                } catch (error) {
                    this.verbose(`Error disconnecting ${channel}: ${error}`);
                }
            };

            // The reader is the only channel that issues blocking reads
            // (BRPOP/BLMOVE with an infinite timeout), and redis cannot process
            // a QUIT while one is in flight. Asking politely therefore buys
            // nothing and costs: until the grace period expires the socket
            // remains a *registered consumer* of the queue, so redis hands it
            // the next message pushed there and the read loop, already torn
            // down, drops it. Whoever owns that queue name by then - a new
            // client that took the name over, in this process or another -
            // silently loses one message. So drop the reader at once, which
            // unregisters it as a consumer without consuming anything.
            if (channel === 'reader') {
                forceDisconnect();

                return;
            }

            // idle channels can complete a graceful quit, but still guarantee a
            // forced disconnect after a short grace period to avoid leaking the
            // socket (which would keep the process alive)
            client.quit().then(forceDisconnect, forceDisconnect);

            const timer = setTimeout(
                forceDisconnect,
                IMQ_CONNECTION_QUIT_TIMEOUT,
            );

            // the grace timer itself must not keep the process alive; while
            // the leaked socket keeps the loop running the timer still fires
            timer.unref();
        } catch (error) {
            this.verbose(`Error destroying ${channel}: ${error}`);
        }
    }

    /**
     * Establishes a given connection channel by its name
     *
     * @param channel - which of the queue's connections to open
     * @param options - connection options; falls back to this queue's own
     * @returns the ready client
     */
    private async connect(
        channel: RedisConnectionChannel,
        options: IMQOptions,
    ): Promise<IRedisClient> {
        this.verbose(`Connecting to ${channel} channel...`);

        const existing = this.connectionOf(channel);

        if (existing) {
            return existing;
        }

        const redis: IRedisClient = new Redis({
            port: options.port || 6379,
            host: options.host || 'localhost',
            username: options.username,
            password: options.password,
            connectionName: this.getChannelName(
                this.name,
                options.prefix || '',
                channel,
            ),
            retryStrategy: noRetryStrategy,
            autoResubscribe: true,
            enableOfflineQueue: true,
            autoResendUnfulfilledCommands: true,
            offlineQueue: true,
            maxRetriesPerRequest: null,
            enableReadyCheck: channel !== 'subscription',
            lazyConnect: true,
        });

        this.bindConnection(channel, redis);
        redis.__imq = true;

        for (const event of [
            'wait',
            'reconnecting',
            'connecting',
            'connect',
            'close',
        ]) {
            redis.on(event, () => this.verbose(`Redis Event fired: ${event}`));
        }

        redis.setMaxListeners(IMQ_REDIS_MAX_LISTENERS_LIMIT);
        redis.on('error', this.onErrorHandler(channel));
        redis.on('end', this.onCloseHandler(channel));

        await redis.connect();

        this.logger.info(
            '%s: %s channel connected, host %s, pid %s',
            this.name,
            channel,
            this.redisKey,
            process.pid,
        );

        switch (channel) {
            case 'reader':
                this.read();
                break;
            case 'writer':
                await this.processDelayed(this.key);
                break;
            case 'watcher':
                await this.initWatcher();
                break;
            case 'subscription':
                await this.restoreSubscription();
                break;
        }

        return redis;
    }

    /**
     * Schedules custom reconnection for a given channel with capped
     * exponential backoff
     *
     * @param channel - which of the queue's connections to reconnect
     */
    private scheduleReconnect(channel: RedisConnectionChannel): void {
        if (this.destroyed || this.reconnecting[channel]) {
            return;
        }

        const attempts = (this.reconnectAttempts[channel] || 0) + 1;
        const delayMs = Math.min(
            RECONNECT_MAX_DELAY,
            RECONNECT_BASE_DELAY * 2 ** (attempts - 1),
        );

        this.reconnecting[channel] = true;
        this.reconnectAttempts[channel] = attempts;

        this.verbose(
            `Scheduling ${channel} reconnect in ${delayMs} ms ` +
                `(attempt ${attempts})`,
        );

        if (this.reconnectTimers[channel]) {
            clearTimeout(this.reconnectTimers[channel]);
        }

        this.reconnectTimers[channel] = setTimeout(
            this.reconnectNow.bind(this, channel),
            delayMs,
        );
    }

    /**
     * Performs a single reconnection attempt for the given channel,
     * rescheduling itself on failure. Errors are handled internally, so the
     * scheduled timer never produces an unhandled rejection.
     *
     * @param channel - which of the queue's connections to reconnect
     */
    private async reconnectNow(channel: RedisConnectionChannel): Promise<void> {
        if (this.destroyed) {
            this.reconnecting[channel] = false;

            return;
        }

        try {
            switch (channel) {
                case 'watcher':
                    this.destroyWatcher();
                    break;
                case 'writer':
                    // replace the broken shared connection without
                    // releasing this instance's reference to it
                    this.destroyWriter(false);
                    break;
                case 'reader':
                    this.destroyChannel(channel);
                    this.reader = undefined;
                    break;
                case 'subscription':
                    this.destroyChannel(channel);
                    this.subscription = undefined;
                    break;
            }

            await this.connect(channel, this.options);
            this.reconnectAttempts[channel] = 0;
            this.reconnecting[channel] = false;

            if (this.reconnectTimers[channel]) {
                clearTimeout(this.reconnectTimers[channel]);
                this.reconnectTimers[channel] = undefined;
            }

            this.verbose(`Reconnected ${channel} channel`);
        } catch (err) {
            this.reconnecting[channel] = false;
            this.verbose(`Reconnect ${channel} failed: ${err}`);
            // bounded by the exponential reconnection backoff, so a redis
            // which stays down cannot make this line flood the log
            this.logLine(
                'warn',
                `reconnect of the ${channel} channel failed, code ${errorCode(
                    err,
                )}`,
            );
            this.scheduleReconnect(channel);
        }
    }

    /**
     * Generates channel name
     *
     * @param contextName - the queue name the connection belongs to
     * @param prefix - the key prefix this queue works under
     * @param name - which of the queue's connections this is
     * @returns the name registered with the broker, ending in this process's
     *          pid and host — which is what makes a connection, and so a lease
     *          owner, identifiable in `CLIENT LIST`
     */
    private getChannelName(
        contextName: string,
        prefix: string,
        name: RedisConnectionChannel,
    ): string {
        const uniqueSuffix = `pid:${process.pid}:host:${hostname()}`;

        return `${prefix}:${contextName}:${name}:${uniqueSuffix}`;
    }

    /**
     * Builds and returns connection error handler
     *
     * @param channel - which of the queue's connections the handler is for
     * @returns the handler to attach to that connection's `error` event
     */
    private onErrorHandler(
        channel: RedisConnectionChannel,
    ): (error: Error) => void {
        return (error: Error & { code?: string }) => {
            this.verbose(`Redis Error: ${error}`);

            if (this.destroyed) {
                return;
            }

            this.logger.error(
                `${this.name}: error connecting redis host ${
                    this.redisKey
                } on ${channel}, pid ${process.pid}:`,
                error,
            );

            if (
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                this.connectionOf(channel)?.status !== 'ready'
            ) {
                this.scheduleReconnect(channel);
            }
        };
    }

    /**
     * Builds and returns redis connection close handler
     *
     * @param channel - which of the queue's connections the handler is for
     * @returns the handler to attach to that connection's `close` event
     */
    private onCloseHandler(channel: RedisConnectionChannel): () => void {
        this.verbose(`Redis ${channel} is closing...`);

        return () => {
            this.initialized = false;

            this.logger.warn(
                '%s: redis connection %s closed on host %s, pid %s!',
                this.name,
                channel,
                this.redisKey,
                process.pid,
            );

            if (!this.destroyed) {
                this.scheduleReconnect(channel);
            }
        };
    }

    /**
     * Unpacks one raw queue message and hands it to the `message` listeners.
     *
     * @param msg - the `[queue key, packed message]` pair as read off redis
     * @returns the promises the listeners returned, empty when none did
     *
     * @remarks
     * The return value is how the caller learns when the listeners are actually
     * finished, which is what {@link RedisQueue.readSafe} needs in order to know
     * when a message's lease may be dropped. `emit()` discards what a listener
     * returns, so the listeners are invoked directly; raw listeners are used so
     * a `once` listener still removes itself and still yields its value, exactly
     * as `emit()` would have arranged.
     *
     * A listener throwing synchronously propagates, as it does through `emit()`.
     * An unreadable message dispatches nothing and reports nothing pending.
     */
    private process(msg: [string, string]): Promise<unknown>[] {
        const [queue, data] = msg;
        const pending: Promise<unknown>[] = [];

        if (!queue || queue !== this.key) {
            return pending;
        }

        try {
            const { id, message, from } = this.unpack(data) as IMessage;

            for (const listener of this.rawListeners('message')) {
                const result = (
                    listener as (...args: unknown[]) => unknown
                ).call(this, message, id, from);

                if (
                    typeof (result as PromiseLike<unknown>)?.then === 'function'
                ) {
                    pending.push(result as Promise<unknown>);
                }
            }
        } catch (err) {
            this.emitError(
                'OnMessage',
                'process error - message is invalid',
                err,
            );
        }

        return pending;
    }

    /**
     * Returns the number of established watcher connections on redis
     */
    private async watcherCount(): Promise<number> {
        if (!this.writer) {
            return 0;
        }

        const rx = new RegExp(
            `\\bname=${escapeRegExp(this.options.prefix || '')}:\\S+?:watcher:`,
        );
        const list = (await this.writer.client('LIST')) as string;

        if (!list || !list.split) {
            return 0;
        }

        return list.split(/\r?\n/).filter(client => rx.test(client)).length;
    }

    /**
     * Moves messages whose delay has elapsed onto their queue.
     *
     * @param key - the queue key whose `:delayed` companion to drain
     */
    private async processDelayed(key: string): Promise<void> {
        try {
            if (!this.scripts.moveDelayed.checksum || !this.writer) {
                return;
            }

            try {
                await this.writer.evalsha(
                    this.scripts.moveDelayed.checksum,
                    2,
                    `${key}:delayed`,
                    key,
                    Date.now(),
                );
            } catch (err) {
                // the script may not be cached on the redis host (fresh
                // host, restart, non-owner instance) - fall back to EVAL,
                // which caches it as a side effect
                if (err instanceof Error && /NOSCRIPT/.test(err.message)) {
                    await this.writer.eval(
                        this.scripts.moveDelayed.code,
                        2,
                        `${key}:delayed`,
                        key,
                        Date.now(),
                    );
                } else {
                    throw err;
                }
            }
        } catch (err) {
            this.emitError(
                'OnProcessDelayed',
                'error processing delayed queue',
                err,
            );
        }
    }

    /**
     * Sweeps for leases whose worker is not coming back and returns their
     * messages to the queue.
     *
     * @param clients - raw `CLIENT LIST` output for this tick, or `undefined`
     *        when it could not be read, in which case liveness is unknown and a
     *        lease is left to its budget rather than guessed at
     */
    private async processWatch(clients?: string): Promise<void> {
        const owners =
            clients === undefined ? undefined : this.connectedOwners(clients);

        const now = Date.now();
        let cursor: string = '0';

        while (true) {
            try {
                const [next, keys] = await this.writer.scan(
                    cursor,
                    'MATCH',
                    `${this.options.prefix}:*:worker:*`,
                    'COUNT',
                    SCAN_COUNT,
                );

                cursor = next;

                await this.processKeys(keys, now, owners);

                if (cursor === '0') {
                    return;
                }
            } catch (err) {
                this.emitError(
                    'OnSafeDelivery',
                    'safe queue message delivery problem',
                    err,
                );

                // abandon only this sweep — the maintenance interval must keep
                // running so the next tick retries. Tearing it down here would
                // be permanent: watch() re-arms the interval only once per
                // watcher connection, guarded by `__ready__`, so a single
                // transient SCAN/LMOVE failure would silently disable lease
                // recovery and cleanup for that connection's whole lifetime.
                // A genuinely lost writer is handled by runSafeCheck().
                return;
            }
        }
    }

    /**
     * Decides whether one worker key has been abandoned.
     *
     * @param key - the worker key
     * @param now - the timestamp this sweep started at
     * @param owners - processes currently connected, or `undefined` when the
     *        client list could not be read
     * @returns whether this key's message should go back on the queue
     *
     * @remarks
     * Which scheme applies is read off the key itself rather than off this
     * queue's options, because the sweeper serves every queue sharing the
     * prefix and they need not be configured alike.
     *
     * A key naming its owner is abandoned on either of two counts, because
     * there are two ways to lose a message. The owner having left the broker's
     * client list catches the process dying — the common case, detected as fast
     * as the socket closes and needing nothing renewed to keep a live lease
     * alive. The deadline catches what liveness cannot see: a worker that is up,
     * connected and serving other messages while one handler has wedged on this
     * one. The budget is honoured even when liveness is unknown, since an
     * exhausted budget is exhausted either way.
     *
     * A key with no owner was written by 3.x, before leases named one. Its
     * deadline is the whole story, exactly as it was then, so a rolling upgrade
     * does not strand it.
     */
    private isAbandoned(
        key: string,
        now: number,
        owners?: Set<string>,
    ): boolean {
        const owner = RX_LEASE_OWNER.exec(key);
        const expired = Number(key.split(':').pop()) < now;

        if (!owner) {
            return expired;
        }

        return expired || (owners ? !owners.has(owner[1]) : false);
    }

    /**
     * Returns the messages of abandoned leases to their queues.
     *
     * @param keys - worker keys from one page of the sweep's `SCAN`
     * @param now - the timestamp the sweep started at, so every key in a pass
     *        is judged against the same instant
     * @param owners - processes currently connected, or `undefined` when the
     *        client list could not be read
     */
    private async processKeys(
        keys: string[],
        now: number,
        owners?: Set<string>,
    ): Promise<void> {
        if (!keys.length) {
            return;
        }

        const requeued = new Map<string, number>();

        this.verbose(
            `Watching ${keys.length} keys: ${keys
                .map(key => `"${key}"`)
                .join(', ')}`,
        );

        try {
            for (const key of keys) {
                if (!this.isAbandoned(key, now, owners)) {
                    continue;
                }

                const kp: string[] = key.split(':');

                kp.pop();

                const target = `${kp.shift()}:${kp.shift()}`;
                const moved = await this.writer.lmove(
                    key,
                    target,
                    'RIGHT',
                    'LEFT',
                );

                // a non-empty result means a message whose lease expired is being
                // delivered a second time - either its worker died or it took
                // longer than the lease ttl. This is one of the two explanations
                // a handler can be given for a duplicate, the other being a
                // worker key that could not be deleted. The packed message is
                // never unpacked here: it carries the payload, and the worker key
                // is never logged either
                if (moved) {
                    // the raw target is a redis key and is never printed: when
                    // the exact prefix cannot be stripped off safely (a prefix
                    // carrying ':' breaks the segment arithmetic above), the
                    // queue is reported as unknown rather than leaked
                    const stripped = `${this.options.prefix}:`;
                    const queue =
                        target.startsWith(stripped) &&
                        target.length > stripped.length
                            ? target.slice(stripped.length)
                            : 'unknown';

                    requeued.set(queue, (requeued.get(queue) || 0) + 1);
                }
            }
        } finally {
            // one line per queue for the whole pass: a backlog of expired
            // leases is reported as a count instead of a line per message.
            // Written in a finally so that re-queues which did happen stay
            // reported even when a later move of the pass throws - the
            // exception itself keeps escaping exactly as before
            for (const [queue, count] of requeued) {
                this.logLine(
                    'warn',
                    `re-queued ${count} messages of expired leases to queue ${
                        queue
                    }`,
                );
            }
        }
    }

    /**
     * Handles one keyspace notification from the watcher subscription.
     *
     * @param args - the `pmessage` arguments; only the last, the expired key,
     *        is used, and only when it is a delayed message's ttl marker
     */
    private async onWatchMessage(...args: any[]): Promise<void> {
        try {
            const key = (args.pop() || '').split(':');

            if (key.pop() !== 'ttl') {
                return;
            }

            key.pop(); // msg id

            await this.processDelayed(key.join(':'));
        } catch (err) {
            this.emitError('OnWatch', 'watch error', err);
        }
    }

    /**
     * Clears safe check interval
     */
    private cleanSafeCheckInterval(): void {
        if (this.safeCheckInterval) {
            clearInterval(this.safeCheckInterval);
            delete this.safeCheckInterval;
        }
    }

    /**
     * Reads the keyspace-notification flags currently configured on the
     * server.
     *
     * @returns the raw flags string, or an empty string when notifications
     *          are disabled
     *
     * @remarks
     * `CONFIG GET` replies as a flat `[name, value]` array over RESP2 and as a
     * map over RESP3, so both shapes are accepted.
     */
    private async currentKeyspaceEvents(): Promise<string> {
        const reply = (await this.writer.config('GET', NOTIFY_EVENTS_PARAM)) as
            | string[]
            | Record<string, string>
            | null;

        if (!reply) {
            return '';
        }

        let value: unknown;

        if (Array.isArray(reply)) {
            const at = reply.indexOf(NOTIFY_EVENTS_PARAM);

            // an unnamed parameter means the reply is not what was asked for,
            // and guessing the value out of it could only make things worse
            value = at < 0 ? undefined : reply[at + 1];
        } else {
            value = reply[NOTIFY_EVENTS_PARAM];
        }

        return typeof value === 'string' ? value : '';
    }

    /**
     * Returns the flags from {@link NOTIFY_EVENTS_REQUIRED} that the given
     * configuration does not already provide.
     *
     * @param current - flags string as reported by `CONFIG GET`
     */
    private missingKeyspaceEvents(current: string): string {
        const covered = current.includes('A')
            ? current + NOTIFY_EVENTS_ALL
            : current;

        return [...NOTIFY_EVENTS_REQUIRED]
            .filter(flag => !covered.includes(flag))
            .join('');
    }

    /**
     * Makes sure the server publishes the keyspace events this queue listens
     * for, preserving whatever else is already configured.
     *
     * @remarks
     * Flags configured out of band — by an operator, or by other code sharing
     * the same Redis — are kept: only the missing ones are appended, and
     * `CONFIG SET` is skipped entirely when nothing needs adding. When the
     * `CONFIG` command is unavailable (e.g. AWS ElastiCache) the read fails and
     * the error is reported without touching the configuration; enable
     * `notify-keyspace-events` out of band in that case.
     */
    private async ensureKeyspaceEvents(): Promise<void> {
        const current = await this.currentKeyspaceEvents();
        const missing = this.missingKeyspaceEvents(current);

        if (!missing) {
            this.verbose(
                `Keyspace events "${current}" already cover ` +
                    `"${NOTIFY_EVENTS_REQUIRED}", keeping them as is`,
            );

            return;
        }

        this.verbose(`Adding "${missing}" to keyspace events "${current}"`);

        await this.writer.config('SET', NOTIFY_EVENTS_PARAM, current + missing);
    }

    /**
     * Setups watch a process on delayed messages
     */
    private watch(): RedisQueue {
        if (!this.writer || !this.watcher || this.watcher.__ready__) {
            return this;
        }

        this.ensureKeyspaceEvents().catch((err: unknown) =>
            this.emitError('OnConfig', 'events config error', err),
        );

        this.watcher.on('pmessage', this.onWatchMessage.bind(this));
        this.watcher
            .psubscribe(
                '__keyevent@0__:expired',
                `${this.options.prefix}:delayed:*`,
            )
            .catch((err: unknown) =>
                this.verbose(`Error subscribing to watcher channel: ${err}`),
            );

        // watch for expired unhandled safe queues
        if (!this.safeCheckInterval && this.options.safeDeliveryTtl != null) {
            // the sweep is watcher maintenance, so it runs on the watcher's own
            // cadence rather than on the processing budget: how long a message
            // may be worked on and how often we look for abandoned ones are
            // different questions, and tying them would make a crashed worker's
            // message wait out a budget meant for a live one. Falls back to the
            // budget only when the watcher check is switched off outright
            this.safeCheckInterval = setInterval(
                this.runSafeCheck.bind(this),
                Number(this.options.watcherCheckDelay) > 0
                    ? Number(this.options.watcherCheckDelay)
                    : Number(this.options.safeDeliveryTtl),
            );
            // maintenance timer must not keep the process alive on its own
            this.safeCheckInterval.unref();
        }

        this.watcher.__ready__ = true;

        return this;
    }

    /**
     * A single safe-delivery maintenance tick: recovers messages from dead
     * workers (when safe delivery is on) and prunes orphaned keys.
     */
    private async runSafeCheck(): Promise<void> {
        if (!this.writer) {
            // one line per interval instance, because the interval is
            // dropped right below and re-armed only by a new watcher
            // connection: from here on nothing recovers abandoned messages
            // and nothing prunes orphaned keys
            const safe = !!this.options.safeDelivery;
            const cleanup = !!this.options.cleanup;

            this.logLine(
                'warn',
                'safe delivery maintenance stopped: no writer connection, ' +
                    `safeDelivery ${safe}, cleanup ${cleanup}`,
            );
            this.cleanSafeCheckInterval();

            return;
        }

        // one CLIENT LIST for the tick. The cleanup pass has always needed it
        // and lease recovery needs the same answer, so asking twice would be
        // the only redis traffic this design could add - and it does not.
        // `undefined` means it could not be read, which is emphatically not
        // "nobody is connected": both consumers treat it as unknown and do
        // nothing rather than reclaiming or deleting
        const clients =
            this.options.cleanup || this.options.safeDelivery
                ? await this.readClients()
                : undefined;

        if (this.options.safeDelivery) {
            await this.processWatch(clients);
        }

        await this.processCleanup(clients);
    }

    /**
     * Reads the broker's client list.
     *
     * @returns the raw `CLIENT LIST` output, or `undefined` when it could not
     *          be read
     *
     * @remarks
     * A failure must not read as "nobody is connected" — that would reclaim
     * every lease in flight and delete every key in the prefix — so it is
     * reported as unknown rather than as an empty list.
     */
    private async readClients(): Promise<string | undefined> {
        try {
            return ((await this.writer.client('LIST')) as string).toString();
        } catch (err) {
            this.logLine(
                'warn',
                `client list read failed, code ${errorCode(err)}`,
            );

            return undefined;
        }
    }

    /**
     * Extracts the processes currently connected to the broker, as the owner
     * tokens stamped into worker keys.
     *
     * @param clients - raw `CLIENT LIST` output
     * @returns owners seen connected now, plus those seen on the previous sweep
     *
     * @remarks
     * Previous-sweep owners are included deliberately, mirroring the grace the
     * cleanup pass already gives reconnecting clients: a worker riding out a
     * reconnect backoff briefly leaves the client list, and reclaiming its
     * leases then would re-deliver work that is still running. One sweep of
     * grace costs one sweep of recovery latency and removes that whole class of
     * duplicate.
     */
    private connectedOwners(clients: string): Set<string> {
        const seen = new Set<string>();

        for (const name of clients.match(RX_CLIENT_NAME) || []) {
            const owner = RX_CLIENT_OWNER.exec(name);

            if (owner) {
                seen.add(owner[1]);
            }
        }

        const owners = new Set<string>([...seen, ...this.lastOwners]);

        this.lastOwners = seen;

        return owners;
    }

    /**
     * Removes keys left behind by clients that are no longer connected.
     *
     * @param clients - raw `CLIENT LIST` output for this tick, so the list is
     *        read once per sweep. Called on its own, this reads its own; a read
     *        that fails throws into the catch below and deletes nothing,
     *        because treating an unreadable list as "no client owns anything"
     *        would delete every key in the prefix
     * @returns this queue instance, or `undefined` when cleanup is disabled
     */
    private async processCleanup(
        clients?: string,
    ): Promise<RedisQueue | undefined> {
        this.verbose('Cleaning up orphaned keys...');

        try {
            if (!this.options.cleanup) {
                return;
            }

            const filter: RegExp = new RegExp(
                escapeRegExp(this.options.prefix || '') +
                    ':' +
                    escapeRegExp(this.options.cleanupFilter || '*').replace(
                        /\\\*/g,
                        '.*',
                    ),
                'i',
            );

            this.verbose(`Cleaning up keys matching ${filter}`);

            const list =
                clients ??
                ((await this.writer.client('LIST')) as string).toString();
            const connectedKeys = (list.match(RX_CLIENT_NAME) || [])
                .filter(
                    (name: string) =>
                        RX_CLIENT_TEST.test(name) && filter.test(name),
                )
                .map((name: string) =>
                    name.replace(/^name=/, '').replace(RX_CLIENT_CLEAN, ''),
                )
                .filter(
                    (name: string, i: number, a: string[]) =>
                        a.indexOf(name) === i,
                );
            // clients seen connected during the previous sweep get one
            // sweep of grace: a client merely reconnecting (the
            // backoff can reach tens of seconds) must not have any keys
            // deleted from under it
            const knownKeys = connectedKeys.concat(
                this.lastConnectedKeys.filter(
                    key => !connectedKeys.includes(key),
                ),
            );

            this.lastConnectedKeys = connectedKeys;

            const keysToRemove: string[] = [];
            let cursor = '0';

            this.verbose(
                `Found connected keys:  ${knownKeys
                    .map(k => `"${k}"`)
                    .join(', ')}`,
            );

            while (true) {
                const [next, keys] = await this.writer.scan(
                    cursor,
                    'MATCH',
                    `${this.options.prefix}:${
                        this.options.cleanupFilter || '*'
                    }`,
                    'COUNT',
                    SCAN_COUNT,
                );

                cursor = next;

                keysToRemove.push(
                    ...keys.filter(
                        key =>
                            key !== this.lockKey &&
                            knownKeys.every(
                                connectedKey =>
                                    key.indexOf(connectedKey) === -1,
                            ),
                    ),
                );

                if (cursor === '0') {
                    break;
                }
            }

            if (keysToRemove.length) {
                const removed = await this.writer.del(...keysToRemove);

                this.verbose(
                    `Keys ${keysToRemove
                        .map(k => `"${k}"`)
                        .join(', ')} were successfully removed!`,
                );

                // deleting the keys of a queue considered abandoned is
                // destructive - a client which was disconnected for two
                // sweeps loses its queue together with a response it still
                // waits for. Neither the keys nor the filter are logged:
                // they carry application names
                if (typeof removed === 'number' && removed > 0) {
                    // bounded by the maintenance interval: one line per
                    // cleanup pass at most, and it already aggregates counts
                    this.logLine(
                        'warn',
                        `cleanup removed ${removed} of ${
                            keysToRemove.length
                        } candidate keys`,
                    );
                }
            }
        } catch (err) {
            this.logger.warn('Clean-up error occurred:', err);
        }

        return this;
    }

    /**
     * Unreliable but fast way of message handling by the queue
     */
    private async readUnsafe(): Promise<void> {
        try {
            const key = this.key;

            while (true) {
                if (!this.reader) {
                    break;
                }

                try {
                    const msg = await this.reader.brpop(key, 0);

                    if (msg) {
                        this.process(msg);
                    }
                } catch (err) {
                    // a closed/ended reader connection means the queue is
                    // stopping, reconnecting, or being destroyed - end the
                    // loop quietly; reconnection (if any) is driven by the
                    // connection close handler, not by this loop
                    if (
                        this.destroyed ||
                        !this.reader ||
                        (err instanceof Error &&
                            /Stream connection ended|Connection is closed/i.test(
                                err.message,
                            ))
                    ) {
                        break;
                    }

                    throw err;
                }
            }
        } catch (err) {
            this.emitError('OnReadUnsafe', 'unsafe reader failed', err);
        }
    }

    /**
     * Ends one lease, dropping the worker key and with it the message.
     *
     * @param workerKey - the key holding the message
     *
     * @remarks
     * Idempotent, and never throws: an undeleted worker key is re-queued by the
     * watcher later, which is one of the causes a handler can be given for a
     * duplicate. The key itself is never logged, as it carries the queue name
     * and the lease id.
     */
    private releaseLease(workerKey: string): void {
        this.writer
            ?.del(workerKey)
            .catch((err: unknown) =>
                this.logLine(
                    'warn',
                    `OnReadSafe: del error, queue ${this.name}, code ${errorCode(
                        err,
                    )}`,
                ),
            );
    }

    /**
     * Reliable but slow method of message handling by message queue.
     *
     * Uses a bounded blocking pop so the lease deadline embedded into the
     * worker key never goes stale: with an infinite block a message
     * arriving long after the pop started would be born with an already
     * expired lease and be immediately re-queued by the watcher.
     */
    private async readSafe(): Promise<void> {
        const key = this.key;
        // blocking timeout in seconds, at most half of the lease ttl, so
        // a claimed message always has at least half the ttl remaining
        const timeout = Math.max(
            0.1,
            Math.min(Number(this.options.safeDeliveryTtl) / 2, READ_MAX_BLOCK) /
                1000,
        );

        while (true) {
            if (!this.reader || !this.writer || this.destroyed) {
                break;
            }

            const expire: number =
                Date.now() + Number(this.options.safeDeliveryTtl);
            const workerKey = `${key}:worker:${randomUUID()}:${OWNER}:${expire}`;
            let msg: string | null;

            try {
                msg = await this.reader.blmove(
                    this.key,
                    workerKey,
                    'RIGHT',
                    'LEFT',
                    timeout,
                );
            } catch (err) {
                // a closed or ended reader connection is the planned case -
                // the queue is stopping, reconnecting or being destroyed,
                // and stop() drops the reader socket on purpose - so it
                // stays quiet. Anything else ends safe reading for good,
                // which must not be silent: the process stays alive and
                // simply consumes nothing
                let planned = this.destroyed || !this.reader;

                if (!planned) {
                    try {
                        planned =
                            err instanceof Error &&
                            /Stream connection ended|Connection is closed/i.test(
                                err.message,
                            );
                    } catch {
                        // a message getter which throws is read as an
                        // unexpected failure - before this catch existed,
                        // such a value would have escaped readSafe() as an
                        // unhandled rejection
                        planned = false;
                    }
                }

                if (!planned) {
                    this.logLine(
                        'warn',
                        `safe reading of queue ${
                            this.name
                        } stopped, code ${errorCode(err)}`,
                    );
                }

                break;
            }

            if (msg === null || msg === undefined) {
                // blocking pop timed out: regenerate the lease and retry
                continue;
            }

            try {
                const pending = this.process([key, msg]);

                if (pending.length) {
                    // the listeners are still working: the message stays in
                    // its worker key, so a worker that dies now leaves it to
                    // be re-queued instead of taking it down. Settled, not
                    // fulfilled - a handler that threw has had its turn, and
                    // re-delivering on a rejection would retry forever
                    void Promise.allSettled(pending).then(() =>
                        this.releaseLease(workerKey),
                    );
                } else {
                    // nothing asynchronous was started, so the listeners are
                    // already done - all a synchronous handler can offer
                    this.releaseLease(workerKey);
                }
            } catch (err) {
                // a single message failure must never kill the read loop, and
                // must not strand its lease either
                this.releaseLease(workerKey);
                this.emitError('OnReadSafe', 'safe reader failed', err);
            }
        }
    }

    /**
     * Initializes a read process on the redis message queue
     */
    private read(): RedisQueue {
        if (!this.reader) {
            this.logger.error(
                `${this.name}: reader connection is not initialized, pid ${
                    process.pid
                } on redis host ${this.redisKey}!`,
            );

            return this;
        }

        const runReader = this.options.safeDelivery
            ? this.readSafe
            : this.readUnsafe;

        process.nextTick(runReader.bind(this));

        return this;
    }

    /**
     * Checks if the watcher connection is locked
     */
    private async isLocked(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.exists(this.lockKey)));
        }

        return false;
    }

    /**
     * Locks watcher connection
     */
    private async lock(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.setnx(this.lockKey, '')));
        }

        return false;
    }

    /**
     * Unlocks watcher connection
     */
    private async unlock(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.del(this.lockKey)));
        }

        return false;
    }

    /**
     * Emits error
     *
     * @param eventName - the internal routine that caught it, used as a
     *        diagnostic label such as `OnMessage` or `OnReadSafe`
     * @param message - human-readable context for the log line
     * @param err - the caught value, wrapped when it is not an `Error`
     */
    private emitError(eventName: string, message: string, err: unknown): void {
        const error = err instanceof Error ? err : new Error(String(err));

        // emitting 'error' with no listeners attached would throw and
        // crash the process from a background routine - always log, but
        // only emit when someone actually listens
        if (this.listenerCount('error') > 0) {
            this.emit('error', error, eventName);
        }

        this.logger.error(
            `${this.name}: ${message}, pid ${
                process.pid
            } on redis host ${this.redisKey}:`,
            err,
        );
        this.verbose(
            `Error in event ${eventName}: ${message}, pid ${
                process.pid
            } on redis host ${this.redisKey}: ${err}`,
        );
    }

    /**
     * Acquires an owner for watcher connection to this instance of the queue
     */
    private async ownWatch(): Promise<void> {
        const owned = await this.lock();

        if (owned) {
            this.verbose('Watcher connection lock acquired!');

            for (const script of Object.keys(this.scripts)) {
                try {
                    // checksums are pre-computed at construction time
                    const checksum = this.scripts[script].checksum as string;

                    const scriptExists = (await this.writer.script(
                        'EXISTS',
                        checksum,
                    )) as number[];
                    const loaded = (scriptExists || []).shift();

                    if (!loaded) {
                        await this.writer.script(
                            'LOAD',
                            this.scripts[script].code,
                        );
                    }
                } catch (err) {
                    this.emitError('OnScriptLoad', 'script load error', err);
                }
            }

            this.watchOwner = true;
            await this.connect('watcher', this.options);
            this.watch();
        }
    }

    /**
     * Attempts to take over an orphaned watcher lock: if the lock is held
     * but no watcher connection is actually alive, releases and re-acquires
     * ownership. Used to resolve a possible watcher deadlock.
     */
    private async resolveWatchLock(): Promise<void> {
        const noWatcher = !(await this.watcherCount());

        if ((await this.isLocked()) && noWatcher) {
            await this.unlock();
            await this.ownWatch();
        }
    }

    /**
     * Initializes a single watcher connection across all queues with the same
     * prefix.
     */
    private async initWatcher(): Promise<void> {
        try {
            if (await this.watcherCount()) {
                return;
            }

            this.verbose('Initializing watcher...');

            await this.ownWatch();

            if (this.watchOwner && this.watcher) {
                return;
            }

            // another instance may hold the lock while its watcher died:
            // wait a small random interval (to avoid a thundering herd) and
            // try to resolve the possible deadlock
            await delay(randomInt(1, 50));
            await this.resolveWatchLock();
        } catch (err) {
            this.logger.error(
                `${this.name}: error initializing watcher, pid ${
                    process.pid
                } on redis host ${this.redisKey}`,
                err,
            );

            throw err;
        }
    }
}
