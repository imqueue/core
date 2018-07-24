/*!
 * Fast messaging queue over Redis
 *
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as os from 'os';
import { gzipSync as gzip, gunzipSync as gunzip } from 'zlib';
import {
    buildOptions,
    IRedisClient,
    IJson,
    IMessageQueue,
    IMQOptions,
    IMessage,
    ILogger,
    redis,
    profile,
    uuid,
} from '.';

export const DEFAULT_IMQ_OPTIONS: IMQOptions = {
    host: 'localhost',
    logger: console,
    port: 6379,
    prefix: 'imq',
    safeDelivery: false,
    safeDeliveryTtl: 5000,
    useGzip: false,
    watcherCheckDelay: 5000,
};

/**
 * Returns SHA1 hash sum of the given string
 *
 * @param {string} str
 * @returns {string}
 */
export function sha1(str: string) {
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
export function intrand(min: number, max: number) {
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

/**
 * Class RedisQueue
 * Implements simple messaging queue over redis.
 */
export class RedisQueue extends EventEmitter implements IMessageQueue {

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

    [name: string]: any;

    /**
     * @event message (message: IJson, id: string, from: string)
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
    private reader: IRedisClient;

    /**
     * Init state for this queue instance
     *
     * @type {boolean}
     */
    private initialized: boolean = false;

    /**
     * True if current instance owns watcher connection, false otherwise
     *
     * @type {boolean}
     */
    private watchOwner = false;

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
    private readonly redisKey: string;

    // noinspection JSMethodCanBeStatic
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
     * S
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

    /**
     * Watcher setter, sets the watcher connection property for this
     * queue instance
     *
     * @param {IRedisClient} conn
     */
    // noinspection JSUnusedLocalSymbols
    private set watcher(conn: IRedisClient) {
        RedisQueue.watchers[this.redisKey] = conn;
    }

    /**
     * Logger instance associated with current queue instance
     * @type {ILogger}
     */
    private get logger(): ILogger {
        // istanbul ignore next
        return this.options.logger || console;
    }

    /**
     * LUA scripts for redis
     *
     * @type {{moveDelayed: {code: string}}}
     */
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
     * Return a lock key for watcher connection
     *
     * @access private
     * @returns {string}
     */
    private get lockKey(): string {
        return `${this.options.prefix}:watch:lock`;
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
     */
    public constructor(
        public name: string,
        options?: Partial<IMQOptions>,
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
    }

    /**
     * Initializes and starts current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async start(): Promise<RedisQueue> {
        if (!this.name) {
            throw new TypeError(`${this.name}: No queue name provided!`);
        }

        if (this.initialized) {
            return this;
        }

        const connPromises = [];

        // istanbul ignore next
        if (!this.reader) {
            connPromises.push(this.connect('reader', this.options));
        }

        if (!this.writer) {
            connPromises.push(this.connect('writer', this.options));
        }

        await Promise.all(connPromises);

        if (!this.signalsInitialized) {
            // istanbul ignore next
            const free = async () => {
                if (this.watchOwner) {
                    await this.unlock();
                }

                process.exit(0);
            };

            process.on('SIGTERM', free);
            process.on('SIGINT', free);

            this.signalsInitialized = true;
        }

        await this.initWatcher();

        this.initialized = true;

        return this;
    }

    /**
     * Sends given message to a given queue (by name)
     *
     * @param {string} toQueue
     * @param {IJson} message
     * @param {number} [delay]
     * @param {(err: Error) => void} [errorHandler]
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async send(
        toQueue: string,
        message: IJson,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string> {
        // istanbul ignore next
        if (!this.writer) {
            await this.start();
        }

        const id = uuid();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;
        const packet = this.pack(data);
        const cb = (error: any) => {
            // istanbul ignore next
            if (error && errorHandler) {
                errorHandler(error);
            }
        };

        if (delay) {
            this.writer.zadd(`${key}:delayed`, Date.now() + delay, packet,
                (err) => {
                    // istanbul ignore next
                    if (err) {
                        cb(err);

                        return;
                    }

                    this.writer.set(`${key}:${id}:ttl`, '', 'PX', delay, 'NX',
                        cb,
                    );
                });
        } else {
            this.writer.lpush(key, packet, cb);
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
        if (this.reader) {
            this.reader.removeAllListeners();
            this.reader.end(false);
            this.reader.unref();
            delete this.reader;
        }

        this.initialized = false;

        return this;
    }

    /**
     * Destroys watcher channel
     *
     * @access private
     */
    @profile()
    private destroyWatcher() {
        if (this.watcher) {
            this.watcher.removeAllListeners();
            this.watcher.end(false);
            this.watcher.unref();
            delete RedisQueue.watchers[this.redisKey];
        }
    }

    /**
     * Destroys writer channel
     *
     * @access private
     */
    @profile()
    private destroyWriter() {
        if (this.writer) {
            this.writer.removeAllListeners();
            this.writer.end(false);
            this.writer.unref();
            delete RedisQueue.writers[this.redisKey];
        }
    }

    /**
     * Gracefully destroys this queue
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async destroy() {
        this.removeAllListeners();
        this.cleanSafeCheckInterval();
        this.destroyWatcher();
        await this.stop();
        await this.clear();
        this.destroyWriter();
    }

    /**
     * Clears queue data in redis;
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async clear(): Promise<RedisQueue> {
        if (!this.writer) {
            return this;
        }

        await Promise.all([
            this.writer.del(this.key),
            this.writer.del(`${this.key}:delayed`),
        ]);

        return this;
    }

    /**
     * Establishes given connection channel by its' name
     *
     * @access private
     * @param {"reader" | "writer" | "watcher"} channel
     * @param {IMQOptions} options
     * @param {any} context
     * @returns {Promise<any>}
     */
    @profile()
    private async connect(
        channel: 'reader' | 'writer' | 'watcher',
        options: IMQOptions,
        context: any = this,
    ) {
        // istanbul ignore next
        if (context[channel]) {
            return context[channel];
        }

        return new Promise((resolve, reject) => {
            context[channel] = redis.createClient(
                // istanbul ignore next
                options.port || 6379,
                // istanbul ignore next
                options.host || 'localhost',
            ) as IRedisClient;
            context[channel].on('ready',
                this.onReadyHandler(options, context, channel, resolve),
            );
            context[channel].on('error',
                this.onErrorHandler(context, channel, reject),
            );
            context[channel].on('end',
                this.onCloseHandler(context, channel),
            );
            context[channel].on('reconnecting',
                this.onReconnectHandler(context, channel),
            );
        });
    }

    /**
     * Builds and returns connection ready state handler
     *
     * @access private
     * @param {IMQOptions} options
     * @param {any} context
     * @param {string} channel
     * @param {(...args: any[]) => void} resolve
     * @return {() => Promise<void>}
     */
    private onReadyHandler(
        options: IMQOptions,
        context: any,
        channel: string,
        resolve: (...args: any[]) => void,
    ): () => Promise<void> {
        return (async () => {
            this.logger.info(
                '%s: %s channel connected, host %s, pid %s',
                context.name, channel, this.redisKey, process.pid,
            );

            await this.setChannelName(
                context[channel],
                context.name,
                options.prefix || '',
                channel
            );

            switch (channel) {
                case 'reader': this.read(); break;
                case 'writer': await this.processDelayed(this.key); break;
                case 'watcher': await this.initWatcher(); break;
            }

            resolve(context[channel]);
        });
    }

    /**
     * Sets channel name
     *
     * @param {IRedisClient} channel
     * @param {string} contextName
     * @param {string} prefix
     * @param {string} name
     */
    private async setChannelName(
        channel: IRedisClient,
        contextName: string,
        prefix: string,
        name: string
    ) {
        await channel.client(
            'setname',
            `${prefix}:${contextName}:${name}:pid:${process.pid}:host:${
                os.hostname()}`,
        );
    }

    /**
     * Builds and returns redis connection reconnect handler
     *
     * @access private
     * @param {any} context
     * @param {string} channel
     * @return {() => void}
     */
    private onReconnectHandler(context: any, channel: string): () => void {
        // istanbul ignore next
        return (async () => {
            if (channel === 'watcher') {
                await context[channel].punsubscribe();
                this.watcher.__ready__ = false;
                this.cleanSafeCheckInterval();
            }

            this.initialized = false;

            this.logger.warn(
                '%s: redis connection %s is reconnecting on host %s, ' +
                'pid %s...',
                context.name, channel, this.redisKey, process.pid,
            );
        });
    }

    /**
     * Builds and returns connection error handler
     *
     * @access private
     * @param context
     * @param {string} channel
     * @param {(...args: any[]) => void} reject
     * @return {(err: Error) => void}
     */
    private onErrorHandler(
        context: any,
        channel: string,
        reject: (...args: any[]) => void,
    ): (err: Error) => void {
        // istanbul ignore next
        return ((err: Error) => {
            this.initialized = false;
            this.logger.error(
                `${context.name}: error connecting redis host ${
                    this.redisKey} on ${
                    channel}, pid ${process.pid}:`,
                err,
            );
            reject(err);
        });
    }

    /**
     * Builds and returns redis connection close handler
     *
     * @access private
     * @param {any} context
     * @param {string} channel
     * @return {(...args: any[]) => any}
     */
    private onCloseHandler(
        context: any,
        channel: string,
    ): (...args: any[]) => any {
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
     * @param {[any , any]} msg
     * @returns {RedisQueue}
     */
    @profile()
    private process(msg: [any, any]): RedisQueue {
        const [queue, data] = msg;

        // istanbul ignore next
        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            const { id, message, from } = this.unpack(data);
            this.emit('message', message, id, from);
        } catch (err) {
            // istanbul ignore next
            this.emitError('OnMessage', 'process error - message is invalid',
                err,
            );
        }

        return this;
    }

    /**
     * Returns number of established watcher connections on redis
     *
     * @access private
     * @returns {Promise<number>}
     */
    // istanbul ignore next
    private async watcherCount(): Promise<number> {
        const rx = new RegExp(
            `\\bname=${this.options.prefix}:[\\S]+?:watcher:`,
        );

        return (await this.writer.client('list') as any || '')
            .split(/\r?\n/)
            .filter((client: string) => rx.test(client))
            .length;
    }

    /**
     * Processes delayed message by its given redis key
     *
     * @access private
     * @param {string} key
     * @returns {Promise<void>}
     */
    private async processDelayed(key: string) {
        try {
            if (this.scripts.moveDelayed.checksum) {
                await this.writer.evalsha(
                    this.scripts.moveDelayed.checksum,
                    2, `${key}:delayed`, key, Date.now(),
                );
            }
        } catch (err) {
            this.emitError('OnProcessDelayed', 'error processing delayed queue',
                err);
        }
    }

    // istanbul ignore next
    /**
     * Watch routine
     *
     * @access private
     * @return {Promise<any>}
     */
    private async processWatch(): Promise<any> {
        const now = Date.now();
        let cursor: string = '0';

        while (true) {
            try {
                const data: Array<[string, string[]]> =
                    await this.writer.scan(
                        cursor, 'match',
                        `${this.options.prefix}:*:worker:*`,
                        'count', '1000',
                    ) as any;

                cursor = data.shift() as any;
                await this.processKeys(data.shift() as any || [], now);

                if (cursor === '0') {
                    return ;
                }
            } catch (err) {
                this.emitError('OnSafeDelivery',
                    'safe queue message delivery problem', err);
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
    private async processKeys(keys: string[], now: number) {
        if (!keys.length) {
            return ;
        }

        for (const key of keys) {
            const kp: string[] = key.split(':');

            if (Number(kp.pop()) < now) {
                continue;
            }

            await this.writer.rpoplpush(key, `${kp.shift()}:${kp.shift()}`);
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
    private async onWatchMessage(...args: any[]) {
        try {
            const key = args.pop().split(':');

            if (key.pop() !== 'ttl') {
                return;
            }

            key.pop(); // msg id

            await this.processDelayed(key.join(':'));
        } catch (err) {
            this.emitError('OnWatch', 'watch error', err);
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
            clearInterval(this.safeCheckInterval);
            delete this.safeCheckInterval;
        }
    }

    /**
     * Setups watch process on delayed messages
     *
     * @access private
     * @returns {RedisQueue}
     */
    // istanbul ignore next
    private watch() {
        if (!this.watcher || this.watcher.__ready__) {
            return this;
        }

        try {
            this.writer.config('set', 'notify-keyspace-events', 'Ex');
        } catch (err) {
            this.emitError('OnConfig', 'events config error', err);
        }

        this.watcher.on('pmessage', this.onWatchMessage.bind(this));
        this.watcher.psubscribe('__keyevent@0__:expired',
            `${this.options.prefix}:delayed:*`,
        );

        // watch for expired unhandled safe queues
        if (this.options.safeDelivery && !this.safeCheckInterval) {
            this.safeCheckInterval = setInterval(async () => {
                if (!this.writer) {
                    this.cleanSafeCheckInterval();

                    return ;
                }

                await this.processWatch();
            }, this.options.safeDeliveryTtl);
        }

        this.watcher.__ready__ = true;

        return this;
    }

    /**
     * Unreliable but fast way of message handling by the queue
     */
    private async readUnsafe() {
        try {
            const key = this.key;

            while (true) {
                if (!this.reader) {
                    break;
                }

                try {
                    const msg: any = await this.reader.brpop(key, 0);
                    this.process(msg);
                } catch (err) {
                    // istanbul ignore next
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
            this.emitError('OnReadUnsafe', 'unsafe reader failed', err);
        }
    }

    /**
     * Reliable but slow method of message handling by message queue
     */
    private async readSafe() {
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
                } catch (err) {
                    // istanbul ignore next
                    break;
                }

                const msg: any = await this.writer.lrange(
                    workerKey, -1, 1,
                );

                this.process([key, msg]);
                this.writer.del(workerKey);
            }
        } catch (err) {
            // istanbul ignore next
            this.emitError('OnReadSafe', 'safe reader failed', err);
        }
    }

    /**
     * Initializes read process on redis message queue
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

        process.nextTick(this[readMethod].bind(this));

        return this;
    }

    /**
     * Checks if watcher connection is locked
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async isLocked(): Promise<boolean> {
        return !!Number(await this.writer.exists(this.lockKey));
    }

    /**
     * Locks watcher connection
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async lock(): Promise<boolean> {
        return !!Number(await this.writer.setnx(this.lockKey, ''));
    }

    /**
     * Unlocks watcher connection
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async unlock(): Promise<boolean> {
        return !!Number(await this.writer.del(this.lockKey));
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
    private emitError(eventName: string, message: string, err: Error) {
        this.emit('error', err, eventName);
        this.logger.error(
            `${this.name}: ${message}, pid ${
                process.pid} on redis host ${this.redisKey}:`,
            err,
        );
    }

    /**
     * Acquires owner for watcher connection to this instance of the queue
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async ownWatch() {
        const owned = await this.lock();

        if (owned) {
            Object.keys(this.scripts).forEach(async (script: string) => {
                try {
                    const checksum = this.scripts[script].checksum = sha1(
                        this.scripts[script].code);
                    const loaded = ((await this.writer.script('exists',
                        checksum,
                    )) as any || []).shift();

                    if (!loaded) {
                        await this.writer.script('load',
                            this.scripts[script].code,
                        );
                    }
                } catch (err) {
                    this.emitError('OnScriptLoad', 'script load error', err);
                }
            });

            this.watchOwner = true;
            await this.connect('watcher', this.options);
            this.watch();
        }
    }

    // istanbul ignore next
    /**
     * Returns watcher lock resolver function
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
     * Initializes single watcher connection across all queues with the same
     * prefix.
     *
     * @returns {Promise<void>}
     */
    // istanbul ignore next
    private async initWatcher() {
        return new Promise<void>(async (resolve, reject) => {
            try {
                if (!await this.watcherCount()) {
                    await this.ownWatch();

                    if (this.watchOwner && this.watcher) {
                        resolve();
                    } else {
                        // check for possible dead-lock to resolve
                        setTimeout(
                            this.watchLockResolver(resolve, reject),
                            intrand(1, 50),
                        );
                    }
                } else {
                    resolve();
                }
            } catch (err) {
                this.logger.error(
                    `${this.name}: error initializing watcher, pid ${
                        process.pid} on redis host ${this.redisKey}`,
                    err,
                );

                reject(err);
            }
        });
    }

}
