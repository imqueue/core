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
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as os from 'os';
import { gunzipSync as gunzip, gzipSync as gzip } from 'zlib';
import {
    IMessageQueue,
    IRedisClient,
    JsonObject,
    IMQOptions,
    IMessage,
    ILogger,
    IMQMode,
    EventMap,
    buildOptions,
    profile,
    uuid,
} from '.';
import Redis from './redis';

const RX_CLIENT_NAME = /name=(\S+)/g;
const RX_CLIENT_TEST = /:(reader|writer|watcher)/;
const RX_CLIENT_CLEAN = /:(reader|writer|watcher).*$/;

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
};

export const IMQ_SHUTDOWN_TIMEOUT = +(process.env.IMQ_SHUTDOWN_TIMEOUT || 1000);

/**
 * Returns SHA1 hash sum of the given string
 *
 * @param {string} str
 * @returns {string}
 */
export function sha1(str: string): string {
    const sha: crypto.Hash = crypto.createHash('sha1');

    sha.update(str);

    return sha.digest('hex');
}

/**
 * Returns random integer between given min and max
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function intrand(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Compress given data and returns binary string
 *
 * @param {any} data
 * @returns {string}
 */
// istanbul ignore next
export function pack(data: any): string {
    return gzip(JSON.stringify(data)).toString('binary');
}

/**
 * Decompress binary string and returns plain data
 *
 * @param {string} data
 * @returns {any}
 */
// istanbul ignore next
export function unpack(data: string): any {
    return JSON.parse(gunzip(Buffer.from(data, 'binary')).toString());
}

type RedisConnectionChannel = 'reader' | 'writer' | 'watcher' | 'subscription';

const IMQ_REDIS_MAX_LISTENERS_LIMIT = +(
    process.env.IMQ_REDIS_MAX_LISTENERS_LIMIT || 10000
);

/**
 * Class RedisQueue
 * Implements simple messaging queue over redis.
 */
export class RedisQueue extends EventEmitter<EventMap>
    implements IMessageQueue {

    [name: string]: any;

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
     * Signals initialization state
     *
     * @type {boolean}
     */
    private signalsInitialized: boolean = false;

    /**
     * Will store check interval reference
     */
    private safeCheckInterval: any;

    /**
     * This queue instance unique key (identifier), for internal use
     */
    public readonly redisKey: string;

    /**
     * LUA scripts for redis
     *
     * @type {{moveDelayed: {code: string}}}
     */
    // tslint:disable-next-line:completed-docs
    private scripts: { [name: string]: { code: string, checksum?: string } } = {
        moveDelayed: {
            code:
                'local messages = redis.call(' +
                    '"zrangebyscore", KEYS[1], "-inf", ARGV[1]) ' +
                'local count = table.getn(messages) ' +
                'local message ' +
                'local i = 1 ' +
                'if count > 0 then ' +
                    'while messages[i] do ' +
                        'redis.call("lpush", KEYS[2], messages[i]) ' +
                        'i = i + 1 ' +
                    'end ' +
                    'redis.call("zremrangebyscore", KEYS[1], ' +
                        '"-inf", ARGV[1]) ' +
                'end ' +
                'return count',
        },
    };

    /**
     * Serializes given data object into string
     *
     * @param {any} data
     * @returns {string}
     */
    private readonly pack: (data: any) => string;

    /**
     * Deserialize string data into object
     *
     * @param {string} data
     * @returns {any}
     */
    private readonly unpack: (data: string) => any;

    /**
     * @constructor
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

        this.options = buildOptions<IMQOptions>(
            DEFAULT_IMQ_OPTIONS,
            options,
        );

        /* tslint:disable */
        this.pack = this.options.useGzip ? pack : JSON.stringify;
        this.unpack = this.options.useGzip ? unpack : JSON.parse;
        /* tslint:enable */
        this.redisKey = `${this.options.host}:${this.options.port}`;

        this.verbose(`Initializing queue on ${
            this.options.host }:${
            this.options.port} with prefix ${
            this.options.prefix } and safeDelivery = ${
            this.options.safeDelivery }, and safeDeliveryTtl = ${
            this.options.safeDeliveryTtl }, and watcherCheckDelay = ${
            this.options.watcherCheckDelay }, and useGzip = ${
            this.options.useGzip }`);
    }

    private verbose(message: string): void {
        if (this.options.verbose) {
            this.logger.info(`[IMQ-CORE][${ this.name }]: ${ message }`);
        }
    }

    /**
     * Creates a subscription channel over redis and sets up channel
     * data read handler
     *
     * @param {string} channel
     * @param {(data: JsonObject) => any} handler
     * @return {Promise<void>}
     */
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => any,
    ): Promise<void> {
        // istanbul ignore next
        if (!channel) {
            throw new TypeError(
                `${ channel }: No subscription channel name provided!`,
            );
        }

        // istanbul ignore next
        if (this.subscriptionName && this.subscriptionName !== channel) {
            throw new TypeError(
                `Invalid channel name provided: expected "${
                    this.subscriptionName}", but "${ channel }" given instead!`,
            );
        } else if (!this.subscriptionName) {
            this.subscriptionName = channel;
        }

        const fcn = `${this.options.prefix}:${this.subscriptionName}`;
        const chan = await this.connect('subscription', this.options);

        await chan.subscribe(fcn);

        // istanbul ignore next
        chan.on('message', (ch: string, message: string) => {
            if (ch === fcn && typeof handler === 'function') {
                handler(JSON.parse(message) as unknown as JsonObject);
            }

            this.verbose(`Received message from ${
                ch } channel, data: ${
                JSON.stringify(message) }`,
            );
        });

        this.verbose(`Subscribed to ${ channel } channel`);
    }

    /**
     * Closes subscription channel
     *
     * @return {Promise<void>}
     */
    public async unsubscribe(): Promise<void> {
        if (this.subscription) {
            this.verbose('Initialize unsubscribing...');

            try {
                if (this.subscriptionName) {
                    await this.subscription.unsubscribe(
                        `${this.options.prefix}:${this.subscriptionName}`,
                    );

                    this.verbose(`Unsubscribed from ${
                        this.subscriptionName } channel`);
                }

                this.subscription.removeAllListeners();
                this.subscription.quit();
                this.subscription.disconnect(false);
            } catch (error) {
                this.verbose(`Unsubscribe error: ${ error }`);
            }
        }

        this.subscriptionName = undefined;
        this.subscription = undefined;
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

        await this.writer.publish(
            `${this.options.prefix}:${ name }`,
            jsonData,
        );

        this.verbose(`Published message to ${
            name } channel, data: ${
            jsonData }
        `);
    }

    /**
     * Initializes and starts current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    public async start(): Promise<RedisQueue> {
        if (!this.name) {
            throw new TypeError(`${ this.name }: No queue name provided!`);
        }

        if (this.initialized) {
            return this;
        }

        this.destroyed = false;

        const connPromises = [];

        // istanbul ignore next
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

        if (!this.signalsInitialized) {
            this.verbose('Setting up OS signal handlers...');
            // istanbul ignore next
            const free = async () => {
                let exitCode = 0;

                setTimeout(() => {
                    this.verbose(`Shutting down after ${
                        IMQ_SHUTDOWN_TIMEOUT } timeout`,
                    );
                    process.exit(exitCode);
                }, IMQ_SHUTDOWN_TIMEOUT);

                try {
                    if (this.watchOwner) {
                        this.verbose('Freeing watcher lock...');
                        await this.unlock();
                    }
                } catch (err) {
                    this.logger.error(err);
                    exitCode = 1;
                }
            };

            process.on('SIGTERM', free);
            process.on('SIGINT', free);
            process.on('SIGABRT', free);

            this.signalsInitialized = true;
            this.verbose('OS signal handlers initialized!');
        }

        await this.initWatcher();
        this.initialized = true;

        return this;
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

        // istanbul ignore next
        if (!this.writer) {
            await this.start();
        }

        if (!this.writer) {
            throw new TypeError('IMQ: unable to initialize queue!');
        }

        const id = uuid();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;
        const packet = this.pack(data);
        const cb = (error: any, op: string) => {
            // istanbul ignore next
            if (error) {
                this.verbose(`Writer ${ op } error: ${ error }`);

                if (errorHandler) {
                    errorHandler(error as unknown as Error);
                }
            }
        };

        if (delay) {
            this.writer.zadd(`${key}:delayed`, Date.now() + delay, packet,
                (err: any) => {
                    // istanbul ignore next
                    if (err) {
                        cb(err, 'ZADD');

                        return;
                    }

                    this.writer.set(`${key}:${id}:ttl`, '', 'PX', delay, 'NX',
                        (err: any) => {
                            // istanbul ignore next
                            if (err) {
                                cb(err, 'SET');

                                return;
                            }
                        },
                    ).catch((err: any) => cb(err, 'SET'));
                });
        } else {
            this.writer.lpush(key, packet, (err: any) => {
                // istanbul ignore next
                if (err) {
                    cb(err, 'LPUSH');

                    return;
                }
            });
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
            this.reader.removeAllListeners();
            this.reader.quit();
            this.reader.disconnect(false);

            delete this.reader;
        }

        this.initialized = false;

        this.verbose('Queue stopped!');

        return this;
    }

    /**
     * Gracefully destroys this queue
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async destroy(): Promise<void> {
        this.verbose('Destroying queue...');
        this.destroyed = true;
        this.removeAllListeners();
        this.cleanSafeCheckInterval();
        this.destroyWatcher();
        await this.stop();
        await this.clear();
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
                this.writer.del(`${ this.key }:delayed`),
            ]);

            this.verbose('Expired queue keys cleared!');
        } catch (err) {
            // istanbul ignore next
            if (this.initialized) {
                this.logger.error(
                    `${ context.name }: error clearing the redis queue host ${
                        this.redisKey } on writer, pid ${ process.pid }:`,
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
     * @return {boolean}
     */
    public isPublisher(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.PUBLISHER;
    }

    /**
     * Returns true if worker mode is enabled on this queue, false otherwise.
     *
     * @return {boolean}
     */
    public isWorker(): boolean {
        return this.mode === IMQMode.BOTH || this.mode === IMQMode.WORKER;
    }

    // noinspection JSMethodCanBeStatic
    /**
     * Writer connection associated with this queue instance
     *
     * @type {IRedisClient}
     */
    private get writer(): IRedisClient {
        return RedisQueue.writers[this.redisKey];
    }

    // noinspection JSUnusedLocalSymbols
    /**
     * Writer connection setter.
     *
     * @param {IRedisClient} conn
     */
    // noinspection JSUnusedLocalSymbols,JSUnusedLocalSymbols
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

    // noinspection JSUnusedLocalSymbols
    /**
     * Watcher setter sets the watcher connection property for this
     * queue instance
     *
     * @param {IRedisClient} conn
     */
    // noinspection JSUnusedLocalSymbols
    private set watcher(conn: IRedisClient) {
        RedisQueue.watchers[this.redisKey] = conn;
    }

    /**
     * Logger instance associated with the current queue instance
     * @type {ILogger}
     */
    private get logger(): ILogger {
        // istanbul ignore next
        return this.options.logger || console;
    }

    /**
     * Return a lock key for watcher connection
     *
     * @access private
     * @returns {string}
     */
    private get lockKey(): string {
        return `${ this.options.prefix }:watch:lock`;
    }

    /**
     * Returns current queue key
     *
     * @access private
     * @returns {string}
     */
    private get key(): string {
        return `${this.options.prefix}:${this.name}`;
    }

    /**
     * Destroys watcher channel
     *
     * @access private
     */
    @profile()
    private destroyWatcher(): void {
        if (this.watcher) {
            this.verbose('Destroying watcher...');
            this.watcher.removeAllListeners();
            this.watcher.quit().catch(e => {
                this.verbose(`Error quitting watcher: ${ e }`);
            });
            this.watcher.disconnect(false);
            delete RedisQueue.watchers[this.redisKey];
            this.verbose('Watcher destroyed!');
        }
    }

    /**
     * Destroys writer channel
     *
     * @access private
     */
    @profile()
    private destroyWriter(): void {
        if (this.writer) {
            this.verbose('Destroying writer...');
            this.writer.removeAllListeners();
            this.writer.quit().catch(e => {
                this.verbose(`Error quitting writer: ${ e }`);
            });
            this.writer.disconnect(false);

            delete RedisQueue.writers[this.redisKey];
            this.verbose('Writer destroyed!');
        }
    }

    /**
     * Establishes a given connection channel by its name
     *
     * @access private
     * @param {RedisConnectionChannel} channel
     * @param {IMQOptions} options
     * @param {any} context
     * @returns {Promise<IRedisClient>}
     */
    private async connect(
        channel: RedisConnectionChannel,
        options: IMQOptions,
        context: RedisQueue = this,
    ): Promise<IRedisClient> {
        this.verbose(`Connecting to ${ channel } channel...`);

        // istanbul ignore next
        if (context[channel]) {
            return context[channel];
        }

        return new Promise((resolve, reject) => {
            const redis = new Redis({
                // istanbul ignore next
                port: options.port || 6379,
                // istanbul ignore next
                host: options.host || 'localhost',
                // istanbul ignore next
                username: options.username,
                // istanbul ignore next
                password: options.password,
                connectionName: this.getChannelName(
                    context.name + '',
                    options.prefix || '',
                    channel,
                ),
                retryStrategy: this.retryStrategy(context),
                autoResubscribe: true,
                enableOfflineQueue: true,
                autoResendUnfulfilledCommands: true,
                offlineQueue: true,
                maxRetriesPerRequest: null,
            });

            context[channel] = redis;
            context[channel].__imq = true;

            for (const event of [
                'wait',
                'reconnecting',
                'connecting',
                'connect',
                'close',
            ]) {
                redis.on(event, () => {
                    context.verbose(`Redis Event fired: ${ event }`);
                });
            }

            redis.setMaxListeners(IMQ_REDIS_MAX_LISTENERS_LIMIT);
            redis.on('ready',
                this.onReadyHandler(
                    context,
                    channel,
                    resolve,
                ) as unknown as () => void,
            );
            redis.on('error',
                this.onErrorHandler(context, channel, reject),
            );
            redis.on('end',
                this.onCloseHandler(context, channel),
            );
        });
    }

    // istanbul ignore next
    /**
     * Builds and returns redis reconnection strategy
     *
     * @param {RedisQueue} context
     * @returns {() => (number | void | null)}
     * @private
     */
    private retryStrategy(
        context: RedisQueue,
    ): () => number | void | null {
        return () => {
            if (context.destroyed) {
                return null;
            }

            this.verbose('Redis connection error, retrying...');

            return null;
        };
    }

    /**
     * Builds and returns connection ready state handler
     *
     * @access private
     * @param {RedisQueue} context
     * @param {RedisConnectionChannel} channel
     * @param {(...args: any[]) => void} resolve
     * @return {() => Promise<void>}
     */
    private onReadyHandler(
        context: RedisQueue,
        channel: RedisConnectionChannel,
        resolve: (...args: any[]) => void,
    ): () => Promise<void> {
        this.verbose(`Redis ${ channel } channel ready!`);

        return (async () => {
            this.logger.info(
                '%s: %s channel connected, host %s, pid %s',
                context.name, channel, this.redisKey, process.pid,
            );

            switch (channel) {
                case 'reader': this.read(); break;
                case 'writer': await this.processDelayed(this.key); break;
                case 'watcher': await this.initWatcher(); break;
            }

            resolve(context[channel]);
        });
    }

    // noinspection JSMethodCanBeStatic
    /**
     * Generates channel name
     *
     * @param {string} contextName
     * @param {string} prefix
     * @param {RedisConnectionChannel} name
     * @return {string}
     */
    private getChannelName(
        contextName: string,
        prefix: string,
        name: RedisConnectionChannel,
    ): string {
        const uniqueSuffix = `pid:${ process.pid }:host:${ os.hostname() }`;

        return`${ prefix }:${ contextName }:${ name }:${ uniqueSuffix }`;
    }

    /**
     * Builds and returns connection error handler
     *
     * @access private
     * @param {RedisQueue} context
     * @param {RedisConnectionChannel} channel
     * @param {(...args: any[]) => void} reject
     * @return {(err: Error) => void}
     */
    private onErrorHandler(
        context: RedisQueue,
        channel: RedisConnectionChannel,
        reject: (...args: any[]) => void,
    ): (err: Error) => void {
        // istanbul ignore next
        return ((err: Error & { code: string }) => {
            this.verbose(`Redis Error: ${ err }`);

            if (this.destroyed) {
                return;
            }

            this.logger.error(
                `${context.name}: error connecting redis host ${
                    this.redisKey} on ${
                    channel}, pid ${process.pid}:`,
                err,
            );

            if (!this.initialized) {
                this.initialized = false;
                reject(err);
            }
        });
    }

    /**
     * Builds and returns redis connection close handler
     *
     * @access private
     * @param {RedisQueue} context
     * @param {RedisConnectionChannel} channel
     * @return {(...args: any[]) => any}
     */
    private onCloseHandler(
        context: RedisQueue,
        channel: RedisConnectionChannel,
    ): (...args: any[]) => any {
        this.verbose(`Redis ${ channel } is closing...`);

        // istanbul ignore next
        return (() => {
            this.initialized = false;
            this.logger.warn(
                '%s: redis connection %s closed on host %s, pid %s!',
                context.name, channel, this.redisKey, process.pid,
            );
        });
    }

    /**
     * Processes given redis-queue message
     *
     * @access private
     * @param {[any, any]} msg
     * @returns {RedisQueue}
     */
    private process(msg: [any, any]): RedisQueue {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const [queue, data] = msg;

        // istanbul ignore next
        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-argument
            const { id, message, from } = this.unpack(data);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            this.emit('message', message, id, from);
        } catch (err) {
            // istanbul ignore next
            this.emitError(
                'OnMessage',
                'process error - message is invalid',
                err as unknown as Error,
            );
        }

        return this;
    }

    /**
     * Returns the number of established watcher connections on redis
     *
     * @access private
     * @returns {Promise<number>}
     */
    // istanbul ignore next
    private async watcherCount(): Promise<number> {
        if (!this.writer) {
            return 0;
        }

        const rx = new RegExp(
            `\\bname=${this.options.prefix}:[\\S]+?:watcher:`,
        );
        const list = <string>await this.writer.client('LIST');

        if (!list || !list.split) {
            return 0;
        }

        return list.split(/\r?\n/).filter(client => rx.test(client)).length;
    }

    /**
     * Processes delayed a message by its given redis key
     *
     * @access private
     * @param {string} key
     * @returns {Promise<void>}
     */
    private async processDelayed(key: string): Promise<void> {
        try {
            if (this.scripts.moveDelayed.checksum) {
                await this.writer.evalsha(
                    this.scripts.moveDelayed.checksum,
                    2, `${ key }:delayed`, key, Date.now(),
                );
            }
        } catch (err) {
            this.emitError(
                'OnProcessDelayed',
                'error processing delayed queue',
                err as unknown as Error,
            );
        }
    }

    // istanbul ignore next
    /**
     * Watch routine
     *
     * @access private
     * @return {Promise<void>}
     */
    private async processWatch(): Promise<void> {
        const now = Date.now();
        let cursor: string = '0';

        while (true) {
            try {
                const data = await this.writer.scan(
                    cursor,
                    'MATCH',
                    `${ this.options.prefix }:*:worker:*`,
                    'COUNT',
                    '1000',
                );

                cursor = data.shift() as string;

                const keys = data.shift() as string[] || [];

                await this.processKeys(keys, now);

                if (cursor === '0') {
                    return;
                }
            } catch (err) {
                this.emitError(
                    'OnSafeDelivery',
                    'safe queue message delivery problem',
                    err as unknown as Error,
                );
                this.cleanSafeCheckInterval();

                return;
            }
        }
    }

    // istanbul ignore next
    /**
     * Process given keys from a message queue
     *
     * @access private
     * @param {string[]} keys
     * @param {number} now
     * @return {Promise<void>}
     */
    private async processKeys(keys: string[], now: number): Promise<void> {
        if (!keys.length) {
            return;
        }

        this.verbose(`Watching ${ keys.length } keys: ${
            keys.map(key => `"${ key }"`).join(', ')
        }`);

        for (const key of keys) {
            const kp: string[] = key.split(':');

            if (Number(kp.pop()) < now) {
                continue;
            }

            await this.writer.rpoplpush(key, `${ kp.shift() }:${ kp.shift() }`);
        }
    }

    // istanbul ignore next
    /**
     * Watch message processor
     *
     * @access private
     * @param {...any[]} args
     * @return {Promise<void>}
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
            this.emitError(
                'OnWatch',
                'watch error',
                err as unknown as Error,
            );
        }
    }

    // istanbul ignore next
    /**
     * Clears safe check interval
     *
     * @access private
     */
    private cleanSafeCheckInterval(): void {
        if (this.safeCheckInterval) {
            clearInterval(this.safeCheckInterval as number);
            delete this.safeCheckInterval;
        }
    }

    /**
     * Setups watch a process on delayed messages
     *
     * @access private
     * @returns {RedisQueue}
     */
    // istanbul ignore next
    private watch(): RedisQueue {
        if (!this.writer || !this.watcher || this.watcher.__ready__) {
            return this;
        }

        try {
            this.writer.config(
                'SET',
                'notify-keyspace-events',
                'Ex',
            ).catch(err => {
                this.emitError(
                    'OnConfig',
                    'events config error',
                    err as unknown as Error,
                );
            });
        } catch (err) {
            this.emitError(
                'OnConfig',
                'events config error',
                err as unknown as Error,
            );
        }

        this.watcher.on(
            'pmessage',
            this.onWatchMessage.bind(this) as unknown as () => void,
        );
        this.watcher.psubscribe(
            '__keyevent@0__:expired',
            `${ this.options.prefix }:delayed:*`,
        ).catch(err => {
            this.verbose(`Error subscribing to watcher channel: ${ err }`);
        });

        // watch for expired unhandled safe queues
        if (!this.safeCheckInterval) {
            if (this.options.safeDeliveryTtl != null) {
                this.safeCheckInterval = setInterval(
                    (async (): Promise<void> => {
                        if (!this.writer) {
                            this.cleanSafeCheckInterval();

                            return ;
                        }

                        if (this.options.safeDelivery) {
                            await this.processWatch();
                        }

                        await this.processCleanup();
                }) as unknown as () => void, this.options.safeDeliveryTtl);
            }
        }

        this.watcher.__ready__ = true;

        return this;
    }

    /**
     * Cleans up orphaned keys from redis
     *
     * @access private
     * @returns {Promise<RedisQueue | undefined>}
     */
    private async processCleanup(): Promise<RedisQueue | undefined> {
        this.verbose('Cleaning up orphaned keys...');

        try {
            if (!this.options.cleanup) {
                return;
            }

            const filter: RegExp = new RegExp(
                this.options.prefix + ':' +
                (this.options.cleanupFilter || '*').replace(/\*/g, '.*'),
                'i',
            );

            this.verbose(`Cleaning up keys matching ${ filter }`);

            const clients: string = (await this.writer.client(
                'LIST',
            ) as string).toString() || '';
            const connectedKeys = (clients.match(RX_CLIENT_NAME) || [])
                .filter((name: string) =>
                    RX_CLIENT_TEST.test(name) && filter.test(name),
                )
                .map((name: string) => name
                    .replace(/^name=/, '')
                    .replace(RX_CLIENT_CLEAN, ''),
                )
                .filter((name: string, i: number, a: string[]) =>
                    a.indexOf(name) === i,
                );
            const keysToRemove: string[] = [];
            let cursor = '0';

            this.verbose(`Found connected keys:  ${
                connectedKeys.map(k => `"${ k }"`).join(', ')
            }`);

            while (true) {
                const data = await this.writer.scan(
                    cursor,
                    'MATCH',
                    `${
                        this.options.prefix}:${
                        this.options.cleanupFilter || '*'
                    }`,
                    'COUNT',
                    '1000',
                );

                cursor = data.shift() as string;

                const keys = data.shift() as string[] || [];

                keysToRemove.push(
                    ...keys.filter(
                        key => key !== this.lockKey &&
                            connectedKeys.every(
                                connectedKey =>
                                    key.indexOf(connectedKey) === -1,
                            ),
                    ),
                );

                if (cursor === '0') {
                    break ;
                }
            }

            if (keysToRemove.length) {
                await this.writer.del(...keysToRemove);

                this.verbose(`Keys ${
                    keysToRemove.map(k => `"${ k }"`).join(', ')
                } were successfully removed!`);
            }
        } catch (err) {
            this.logger.warn('Clean-up error occurred:', err);
        }

        return this;
    }

    // noinspection JSUnusedLocalSymbols
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
                    // istanbul ignore next
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                    if (err.message.match(/Stream connection ended/)) {
                        break;
                    }

                    // istanbul ignore next
                    // noinspection ExceptionCaughtLocallyJS
                    throw err;
                }
            }
        } catch (err) {
            // istanbul ignore next
            this.emitError(
                'OnReadUnsafe',
                'unsafe reader failed',
                err as unknown as Error,
            );
        }
    }

    // noinspection JSUnusedLocalSymbols
    /**
     * Reliable but slow method of message handling by message queue
     */
    private async readSafe(): Promise<void> {
        try {
            const key = this.key;

            while (true) {
                const expire: number = Date.now() +
                    Number(this.options.safeDeliveryTtl);
                const workerKey = `${key}:worker:${uuid()}:${expire}`;

                if (!this.reader || !this.writer) {
                    break;
                }

                try {
                    await this.reader.brpoplpush(this.key, workerKey, 0);
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                } catch (_) {
                    // istanbul ignore next
                    break;
                }

                const msgArr: any = await this.writer.lrange(
                    workerKey, -1, 1,
                );

                if (!msgArr || msgArr?.length !== 1) {
                    // noinspection ExceptionCaughtLocallyJS
                    throw new Error('Wrong messages count');
                }

                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const [msg] = msgArr as any[];

                this.process([key, msg]);
                this.writer.del(workerKey).catch(e =>
                    this.logger.warn('OnReadSafe: del error', e));
            }
        } catch (err) {
            // istanbul ignore next
            this.emitError(
                'OnReadSafe',
                'safe reader failed',
                err as unknown as Error,
            );
        }
    }

    /**
     * Initializes a read process on the redis message queue
     *
     * @returns {RedisQueue}
     */
    private read(): RedisQueue {
        // istanbul ignore next
        if (!this.reader) {
            this.logger.error(
                `${this.name}: reader connection is not initialized, pid ${
                    process.pid} on redis host ${this.redisKey}!`,
            );

            return this;
        }

        const readMethod = this.options.safeDelivery
            ? 'readSafe'
            : 'readUnsafe';

        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        process.nextTick(this[readMethod].bind(this));

        return this;
    }

    /**
     * Checks if the watcher connection is locked
     *
     * @access private
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
     * @access private
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
     * @access private
     * @returns {Promise<boolean>}
     */
    private async unlock(): Promise<boolean> {
        if (this.writer) {
            return Boolean(Number(await this.writer.del(this.lockKey)));
        }

        return false;
    }

    // istanbul ignore next
    /**
     * Emits error
     *
     * @access private
     * @param {string} eventName
     * @param {string} message
     * @param {Error} err
     */
    private emitError(eventName: string, message: string, err: Error): void {
        this.emit('error', err, eventName);
        this.logger.error(
            `${this.name}: ${ message }, pid ${
                process.pid } on redis host ${ this.redisKey }:`,
            err,
        );
        this.verbose(`Error in event ${
            eventName }: ${ message }, pid ${
            process.pid } on redis host ${ this.redisKey }: ${ err }`);
    }

    /**
     * Acquires an owner for watcher connection to this instance of the queue
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async ownWatch(): Promise<void> {
        const owned = await this.lock();

        if (owned) {
            this.verbose('Watcher connection lock acquired!');

            for (const script of Object.keys(this.scripts)) {
                try {
                    const checksum = sha1(this.scripts[script].code);

                    this.scripts[script].checksum = checksum;

                    const scriptExists = await this.writer.script(
                        'EXISTS',
                        checksum,
                    ) as number[];
                    const loaded = (scriptExists || []).shift();

                    if (!loaded) {
                        await this.writer.script(
                            'LOAD',
                            this.scripts[script].code,
                        );
                    }
                } catch (err) {
                    this.emitError(
                        'OnScriptLoad',
                        'script load error',
                        err as unknown as Error,
                    );
                }
            }

            this.watchOwner = true;
            await this.connect('watcher', this.options);
            this.watch();
        }
    }

    // istanbul ignore next
    /**
     * This method returns a watcher lock resolver function
     *
     * @access private
     * @param {(...args: any[]) => void} resolve
     * @param {(...args: any[]) => void} reject
     * @return {() => Promise<any>}
     */
    private watchLockResolver(
        resolve: (...args: any[]) => void,
        reject: (...args: any[]) => void,
    ): () => Promise<any> {
        return (async () => {
            try {
                const noWatcher = !await this.watcherCount();

                if (await this.isLocked() && noWatcher) {
                    await this.unlock();
                    await this.ownWatch();
                }

                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Initializes a single watcher connection across all queues with the same
     * prefix.
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async initWatcher(): Promise<void> {
        return new Promise<void>(
            (async (
                resolve: (...args: any[]) => void,
                reject: (...args: any[]) => void,
            ): Promise<void> => {
                try {
                    if (!await this.watcherCount()) {
                        this.verbose('Initializing watcher...');

                        await this.ownWatch();

                        if (this.watchOwner && this.watcher) {
                            resolve();
                        } else {
                            // check for possible deadlock to resolve
                            setTimeout(
                                this.watchLockResolver(
                                    resolve,
                                    reject,
                                ) as unknown as () => void,
                                intrand(1, 50),
                            );
                        }
                    } else {
                        resolve();
                    }
                } catch (err) {
                    this.logger.error(
                        `${ this.name }: error initializing watcher, pid ${
                            process.pid } on redis host ${ this.redisKey }`,
                        err,
                    );

                    reject(err);
                }
            }) as unknown as (
                resolve: (...args: any[]) => void,
                reject: (...args: any[]) => void,
            ) => void,
        );
    }
}
