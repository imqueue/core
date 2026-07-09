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
 * ioredis retry strategy that disables the built-in reconnection — this
 * queue performs its own capped-backoff reconnection instead.
 *
 * @returns {null}
 */
function noRetryStrategy(): null {
    return null;
}

/**
 * Resolves after the given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export const DEFAULT_IMQ_OPTIONS: IMQOptions = {
    host: 'localhost',
    port: 6379,
    cleanup: false,
    cleanupFilter: '*',
    logger: console,
    prefix: 'imq',
    safeDelivery: false,
    safeDeliveryTtl: 5000,
    useGzip: false,
    watcherCheckDelay: 5000,
    handleSignals: true,
};

export const IMQ_SHUTDOWN_TIMEOUT = envInt('IMQ_SHUTDOWN_TIMEOUT', 1000);

/**
 * Grace period (ms) for a graceful QUIT to complete before a channel is
 * forcibly disconnected. A reader blocked on an infinite BRPOP/BLMOVE can
 * never let QUIT through, so without this the socket would leak and keep
 * the process alive.
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
 * Class RedisQueue
 * Implements a simple messaging queue over redis.
 */
export class RedisQueue
    extends EventEmitter<EventMap>
    implements IMessageQueue
{
    /**
     * Writer connections collection
     *
     * @type {{}}
     */
    private static writers: { [key: string]: IRedisClient } = {};

    /**
     * Watcher connections collection
     *
     * @type {{}}
     */
    private static watchers: { [key: string]: IRedisClient } = {};

    /**
     * Number of started queue instances per shared writer connection key
     *
     * @type {{}}
     */
    private static writerRefs: { [key: string]: number } = {};

    /**
     * All started queue instances within the current process
     *
     * @type {Set<RedisQueue>}
     */
    private static readonly instances: Set<RedisQueue> = new Set();

    /**
     * True when process-level signal handlers were bound
     *
     * @type {boolean}
     */
    private static signalsBound: boolean = false;

    /**
     * @event message (message: JsonObject, id: string, from: string)
     */

    /**
     * This queue instance options
     *
     * @type {IMQOptions}
     */
    public options: IMQOptions;

    /**
     * Reader connection associated with this queue instance
     *
     * @type {IRedisClient}
     */
    private reader?: IRedisClient;

    /**
     * Channel connection associated with this queue instance
     * Specially designed for client subscriptions to server-emitted events
     *
     * @type {IRedisClient}
     */
    private subscription?: IRedisClient;

    /**
     * Channel name for subscriptions
     *
     * @type {string}
     */
    private subscriptionName?: string;

    /**
     * Init state for this queue instance
     *
     * @type {boolean}
     */
    private initialized: boolean = false;

    /**
     * Signals if the queue was destroyed
     *
     * @type {boolean}
     */
    private destroyed: boolean = false;

    /**
     * True if the current instance owns a watcher connection, false otherwise
     *
     * @type {boolean}
     */
    private watchOwner: boolean = false;

    /**
     * Subscription handlers registered through subscribe(). Kept to be
     * able to restore the subscription after a connection replacement.
     *
     * @type {Array<(data: JsonObject) => void>}
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
     * Connected client keys seen during the previous cleanup sweep. Used
     * to give temporarily disconnected clients one sweep of grace before
     * removing their keys.
     */
    private lastConnectedKeys: string[] = [];

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
    private reconnectAttempts: Partial<Record<RedisConnectionChannel, number>> =
        {};
    private reconnecting: Partial<Record<RedisConnectionChannel, boolean>> = {};

    /**
     * This queue instance unique key (identifier), for internal use
     */
    public readonly redisKey: string;

    /**
     * Lua scripts for redis
     *
     * @type {{moveDelayed: {code: string}}}
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
     * @param {unknown} data
     * @returns {string}
     */
    private readonly pack: (data: unknown) => string;

    /**
     * Deserialize string data into an object
     *
     * @param {string} data
     * @returns {unknown}
     */
    private readonly unpack: (data: string) => unknown;

    /**
     * @param {string} name
     * @param {IMQOptions} [options]
     * @param {IMQMode} [mode]
     */
    public constructor(
        public name: string,
        options?: Partial<IMQOptions>,
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

    private verbose(message: string): void {
        if (this.options.verbose) {
            this.logger.info(`[IMQ-CORE][${this.name}]: ${message}`);
        }
    }

    /**
     * Creates a subscription channel over redis and sets up channel
     * data read handler
     *
     * @param {string} channel
     * @param {(data: JsonObject) => void} handler
     * @returns {Promise<void>}
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
    }

    /**
     * Attaches a subscription message handler to a given channel
     * connection
     *
     * @param {IRedisClient} chan
     * @param {(data: JsonObject) => void} handler
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
     *
     * @returns {Promise<void>}
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
    }

    /**
     * Closes subscription channel
     *
     * @returns {Promise<void>}
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
     * @param {string} [toName]
     * @param {JsonObject} data
     */
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        if (!this.writer) {
            throw new TypeError('Writer is not connected!');
        }

        const jsonData = JSON.stringify(data);
        const name = toName || this.name;

        await this.writer.publish(`${this.options.prefix}:${name}`, jsonData);

        this.verbose(`Published message to ${name} channel, data: ${jsonData}
        `);
    }

    /**
     * Initializes and starts current queue routines
     *
     * @returns {Promise<RedisQueue>}
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
     *
     * @returns {Promise<void>}
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
     *
     * @returns {Promise<void>}
     */
    private async runWatcherCheck(): Promise<void> {
        if (this.watcherCheckBusy || this.destroyed || !this.writer) {
            return;
        }

        this.watcherCheckBusy = true;

        try {
            if (!(await this.watcherCount())) {
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
     * Sends a given message to a given queue (by name)
     *
     * @param {string} toQueue
     * @param {JsonObject} message
     * @param {number} [delay]
     * @param {(err: Error) => void} [errorHandler]
     * @returns {Promise<RedisQueue>}
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
        const onWriteError = (error: unknown, op: string): void => {
            if (error) {
                this.verbose(`Writer ${op} error: ${error}`);

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
     * Stops current queue routines
     *
     * @returns {Promise<RedisQueue>}
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
     * @param {boolean} [clearData] - when true, also clears queue data
     * @returns {Promise<void>}
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
     * Clears queue data in redis
     *
     * @returns {Promise<void>}
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
     * Retrieves the current count of messages in the queue
     *
     * @returns {Promise<number>}
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
     *
     * @returns {boolean}
     */
    public isPublisher(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.PUBLISHER;
    }

    /**
     * Returns true if worker mode is enabled on this queue, false otherwise.
     *
     * @returns {boolean}
     */
    public isWorker(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.WORKER;
    }

    /**
     * Returns false only when this queue is known to be unable to accept
     * writes right now — i.e., it has a writer connection currently
     * in a non-ready (reconnecting/closed) state. A queue that has not yet
     * connected is considered available, since a sending lazily connects it.
     * Used for health-aware routing in the clustered queue.
     *
     * @returns {boolean}
     */
    public get available(): boolean {
        return !this.writer || this.writer.status === 'ready';
    }

    /**
     * Writer connection associated with this queue instance
     *
     * @type {IRedisClient}
     */
    private get writer(): IRedisClient {
        return RedisQueue.writers[this.redisKey];
    }

    /**
     * Writer connection setter.
     *
     * @param {IRedisClient} conn
     */
    private set writer(conn: IRedisClient) {
        RedisQueue.writers[this.redisKey] = conn;
    }

    /**
     * Watcher connection instance associated with this queue instance
     *
     * @type {IRedisClient}
     */
    private get watcher(): IRedisClient {
        return RedisQueue.watchers[this.redisKey];
    }

    /**
     * Watcher setter sets the watcher connection property for this
     * queue instance
     *
     * @param {IRedisClient} conn
     */
    private set watcher(conn: IRedisClient) {
        RedisQueue.watchers[this.redisKey] = conn;
    }

    /**
     * Returns the connection currently bound to the given channel, if any.
     *
     * @param {RedisConnectionChannel} channel
     * @returns {IRedisClient | undefined}
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
     * @param {RedisConnectionChannel} channel
     * @param {IRedisClient} conn
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
     * @type {ILogger}
     */
    private get logger(): ILogger {
        return this.options.logger || console;
    }

    /**
     * Return a lock key for watcher connection
     *
     * @returns {string}
     */
    private get lockKey(): string {
        return `${this.options.prefix}:watch:lock`;
    }

    /**
     * Returns current queue key
     *
     * @returns {string}
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

            // graceful quit for idle connections, but a reader blocked on an
            // infinite BRPOP/BLMOVE never lets QUIT through, so guarantee a
            // forced disconnect after a short grace period to avoid leaking
            // the socket (which would keep the process alive)
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
     * @param {RedisConnectionChannel} channel
     * @param {IMQOptions} options
     * @returns {Promise<IRedisClient>}
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
     * @param {RedisConnectionChannel} channel
     * @private
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
     * @param {RedisConnectionChannel} channel
     * @returns {Promise<void>}
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
            this.scheduleReconnect(channel);
        }
    }

    /**
     * Generates channel name
     *
     * @param {string} contextName
     * @param {string} prefix
     * @param {RedisConnectionChannel} name
     * @returns {string}
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
     * @param {RedisConnectionChannel} channel
     * @returns {(err: Error) => void}
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
     * @param {RedisConnectionChannel} channel
     * @returns {() => void}
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
     * Processes given redis-queue message
     *
     * @param {[string, string]} msg
     * @returns {RedisQueue}
     */
    private process(msg: [string, string]): RedisQueue {
        const [queue, data] = msg;

        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            const { id, message, from } = this.unpack(data) as IMessage;

            this.emit('message', message, id, from);
        } catch (err) {
            this.emitError(
                'OnMessage',
                'process error - message is invalid',
                err,
            );
        }

        return this;
    }

    /**
     * Returns the number of established watcher connections on redis
     *
     * @returns {Promise<number>}
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
     * Processes delayed a message by its given redis key
     *
     * @param {string} key
     * @returns {Promise<void>}
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
     * Watch routine
     *
     * @returns {Promise<void>}
     */
    private async processWatch(): Promise<void> {
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

                await this.processKeys(keys, now);

                if (cursor === '0') {
                    return;
                }
            } catch (err) {
                this.emitError(
                    'OnSafeDelivery',
                    'safe queue message delivery problem',
                    err,
                );
                this.cleanSafeCheckInterval();

                return;
            }
        }
    }

    /**
     * Process given keys from a message queue
     *
     * @param {string[]} keys
     * @param {number} now
     * @returns {Promise<void>}
     */
    private async processKeys(keys: string[], now: number): Promise<void> {
        if (!keys.length) {
            return;
        }

        this.verbose(
            `Watching ${keys.length} keys: ${keys
                .map(key => `"${key}"`)
                .join(', ')}`,
        );

        for (const key of keys) {
            const kp: string[] = key.split(':');

            // the last key segment is the worker's lease deadline: only
            // re-queue messages of workers whose lease has expired (the
            // worker died mid-processing); fresh leases belong to live
            // workers and must not be touched
            if (Number(kp.pop()) >= now) {
                continue;
            }

            await this.writer.lmove(
                key,
                `${kp.shift()}:${kp.shift()}`,
                'RIGHT',
                'LEFT',
            );
        }
    }

    /**
     * Watch message processor
     *
     * @param {...any[]} args
     * @returns {Promise<void>}
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
     * Setups watch a process on delayed messages
     *
     * @returns {RedisQueue}
     */
    private watch(): RedisQueue {
        if (!this.writer || !this.watcher || this.watcher.__ready__) {
            return this;
        }

        try {
            this.writer
                .config('SET', 'notify-keyspace-events', 'Ex')
                .catch((err: unknown) =>
                    this.emitError('OnConfig', 'events config error', err),
                );
        } catch (err) {
            this.emitError('OnConfig', 'events config error', err);
        }

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
            this.safeCheckInterval = setInterval(
                this.runSafeCheck.bind(this),
                this.options.safeDeliveryTtl,
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
     *
     * @returns {Promise<void>}
     */
    private async runSafeCheck(): Promise<void> {
        if (!this.writer) {
            this.cleanSafeCheckInterval();

            return;
        }

        if (this.options.safeDelivery) {
            await this.processWatch();
        }

        await this.processCleanup();
    }

    /**
     * Cleans up orphaned keys from redis
     *
     * @returns {Promise<RedisQueue | undefined>}
     */
    private async processCleanup(): Promise<RedisQueue | undefined> {
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

            const clients: string =
                ((await this.writer.client('LIST')) as string).toString() || '';
            const connectedKeys = (clients.match(RX_CLIENT_NAME) || [])
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
                await this.writer.del(...keysToRemove);

                this.verbose(
                    `Keys ${keysToRemove
                        .map(k => `"${k}"`)
                        .join(', ')} were successfully removed!`,
                );
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
            Number(this.options.safeDeliveryTtl) / 2000,
        );

        while (true) {
            if (!this.reader || !this.writer || this.destroyed) {
                break;
            }

            const expire: number =
                Date.now() + Number(this.options.safeDeliveryTtl);
            const workerKey = `${key}:worker:${randomUUID()}:${expire}`;
            let msg: string | null;

            try {
                msg = await this.reader.blmove(
                    this.key,
                    workerKey,
                    'RIGHT',
                    'LEFT',
                    timeout,
                );
            } catch {
                // reader connection ended (stop/reconnect)
                break;
            }

            if (msg === null || msg === undefined) {
                // blocking pop timed out: regenerate the lease and retry
                continue;
            }

            try {
                this.process([key, msg]);
                this.writer
                    .del(workerKey)
                    .catch(e => this.logger.warn('OnReadSafe: del error', e));
            } catch (err) {
                // a single message failure must never kill the read loop
                this.emitError('OnReadSafe', 'safe reader failed', err);
            }
        }
    }

    /**
     * Initializes a read process on the redis message queue
     *
     * @returns {RedisQueue}
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
     *
     * @returns {Promise<boolean>}
     */
    private async isLocked(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.exists(this.lockKey)));
        }

        return false;
    }

    /**
     * Locks watcher connection
     *
     * @returns {Promise<boolean>}
     */
    private async lock(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.setnx(this.lockKey, '')));
        }

        return false;
    }

    /**
     * Unlocks watcher connection
     *
     * @returns {Promise<boolean>}
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
     * @param {string} eventName
     * @param {string} message
     * @param {unknown} err
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
     *
     * @returns {Promise<void>}
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
     *
     * @returns {Promise<void>}
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
     *
     * @returns {Promise<void>}
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
