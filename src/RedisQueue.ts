/*!
 * Fast messaging queue for request-reply pattern using redis and it's
 * pub/sub as transport
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
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
import {
    redis,
    IRedisClient,
    IJson,
    IMessageQueue,
    IMQOptions,
    IMessage,
    ILogger,
    profile,
    uuid
} from '.';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as crypto from 'crypto';
import { gzipSync as gzip, gunzipSync as gunzip } from 'zlib';

const DEFAULT_OPTIONS: IMQOptions = {
    host: 'localhost',
    port: 6379,
    prefix: 'imq',
    logger: console,
    watcherCheckDelay: 5000,
    useGzip: false
};

/**
 * Returns SHA1 hash sum of the given string
 *
 * @param {string} str
 * @returns {string}
 */
export function sha1(str: string) {
    let sha: crypto.Hash = crypto.createHash('sha1');

    sha.update(str);

    return sha.digest('hex');
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
export function unpack(data: string): string {
    return JSON.parse(gunzip(Buffer.from(data, 'binary')).toString());
}

/**
 * Class RedisQueue
 * Implements simple messaging queue over redis.
 */
export class RedisQueue extends EventEmitter implements IMessageQueue {

    [name: string]: any;

    /**
     * @event message (message: IJson, id: string, from: string)
     */

    private reader: IRedisClient;
    private static writer: IRedisClient;
    private watcher: IRedisClient;

    private initialized: boolean = false;
    private watchOwner = false;

    private watchCheckInterval: any;
    private signalsInitialized: boolean = false;

    /**
     * @type {IRedisClient}
     */
    private get writer(): IRedisClient {
        return RedisQueue.writer;
    }

    /**
     * @type {ILogger}
     */
    private get logger(): ILogger {
        // istanbul ignore next
        return this.options.logger || console;
    };

    private scripts: { [name: string]: { code: string, checksum?: string } } = {
        moveDelayed: {
            code:
                'local messages = redis.call('+
                    '"zrangebyscore", KEYS[1], "-inf", ARGV[1]) '+
                'local count = table.getn(messages) '+
                'local message '+
                'local i = 1 '+
                'if count > 0 then '+
                    'while messages[i] do '+
                        'redis.call("lpush", KEYS[2], messages[i]) '+
                        'i = i + 1 '+
                    'end '+
                    'redis.call("zremrangebyscore", KEYS[1], "-inf", ARGV[1]) '+
                'end '+
                'return count'
        }
    };

    /**
     * Return a lock key for watcher connection
     *
     * @access private
     * @returns {string}
     */
    private get lockKey() {
        return `${this.options.prefix}:watch:lock`;
    }

    /**
     * Returns current queue key
     *
     * @access private
     * @returns {string}
     */
    private get key() {
        return `${this.options.prefix}:${this.name}`;
    }

    private pack: Function;
    private unpack: Function;

    public options: IMQOptions = DEFAULT_OPTIONS;

    /**
     * @constructor
     * @param {string} name
     * @param {IMQOptions} [options]
     */
    constructor(
        public name: string,
        options?: Partial<IMQOptions>
    ) {
        super();

        if (options) {
            this.options = Object.assign({}, DEFAULT_OPTIONS, options);
        }

        this.pack = this.options.useGzip ? pack : JSON.stringify;
        this.unpack = this.options.useGzip ? unpack : JSON.parse;
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
        context: any = this
    ) {
        // istanbul ignore next
        if (context[channel]) {
            return context[channel];
        }

        return new Promise((resolve, reject) => {
            context[channel] = <IRedisClient>redis.createClient(
                options.port,
                options.host
            );
            context[channel].on('ready', async () => {
                this.logger.info(`RedisQueue: ${channel} channel connected`);

                await context[channel].client(
                    'setname',
                    `${options.prefix}:${context.name}:${channel
                    }:pid:${process.pid}:host:${os.hostname()}`
                );

                resolve(context[channel]);
            });
            // istanbul ignore next
            context[channel].on('error', (err: Error) => {
                this.initialized = false;
                this.logger.error(`Error connecting redis on ${channel}:`, err);
                reject(err);
            });
            // istanbul ignore next
            context[channel].on('end', () => {
                this.initialized = false;
                this.logger.warn(`Redis connection ${channel} closed!`);
            });
            // istanbul ignore next
            context[channel].on('reconnecting', () => {
                this.initialized = false;
                this.logger.warn(
                    `Redis connection ${channel} is reconnecting!`
                );
            });
        });
    }

    /**
     * Processes given redis-queue message
     *
     * @access private
     * @param {[any , any]} message
     * @returns {RedisQueue}
     */
    @profile()
    private process(message: [any, any]): RedisQueue {
        let [queue, data] = message;

        // istanbul ignore next
        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            const { id, message, from } = this.unpack(data);
            this.emit('message', message, id, from);
        }

        catch (err) {
            // istanbul ignore next
            this.logger.error('RedisQueue message is invalid:', err);
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
        return (<any>await this.writer.client('list') || '')
            .split(/\r?\n/)
            .filter((client: string) =>
                /\bname=[\S]+?:watcher:/.test(client)
            ).length;
    }

    /**
     * Processes delayed message by its given redis key
     *
     * @access private
     * @param {string} key
     * @returns {Promise<void>}
     */
    private async processDelayed(key: string) {
        const self: any = this;

        if (this.scripts.moveDelayed.checksum) {
            await self.writer.evalsha(
                this.scripts.moveDelayed.checksum,
                2, `${key}:delayed`, key, Date.now()
            );
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
        const self: any = this;

        if (!self.watcher || self.watcher.__ready__) {
            return this;
        }

        try {
            self.writer.config('set', 'notify-keyspace-events', 'Ex');
        }

        catch (err) {
            this.logger.error('RedisQueue events error:', err);
        }

        self.watcher.on('pmessage', async (...args: any[]) => {
            try {
                const key = args.pop().split(':');

                if (key.pop() !== 'ttl') {
                    return;
                }
                key.pop(); // msg id

                await this.processDelayed(key.join(':'));
            }

            catch (err) {
                this.logger.error('RedisQueue watch error:', err);
            }
        });

        self.watcher.psubscribe(
            '__keyevent@0__:expired',
            `${this.options.prefix}:delayed:*`
        );

        self.watcher.__ready__ = true;

        return this;
    }

    /**
     * Initializes read process on redis message queue
     *
     * @returns {RedisQueue}
     */
    private read(): RedisQueue {
        // istanbul ignore next
        if (!this.reader) {
            this.logger.error('Reader connection is not initialized!');
            return this;
        }

        process.nextTick(async () => {
            try {
                while (true) {
                    if (!this.reader) {
                        break;
                    }

                    const msg: any = await this.reader.brpop(this.key, 0);
                    this.process(msg);
                }
            }

            catch (err) {
                // istanbul ignore next
                this.logger.error('RedisQueue reader failed:', err);
            }
        });

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
                    const loaded = ((<any>await this.writer.script(
                        'exists',
                        checksum
                    )) || []).shift();

                    if (!loaded) {
                        await this.writer.script(
                            'load',
                            this.scripts[script].code
                        );
                    }
                }

                catch (err) {
                    this.logger.error('Script load error:', err);
                }
            });

            this.watchOwner = true;
            await this.connect('watcher', this.options);
            this.watch();
        }
    }

    /**
     * Initializes and starts current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async start(): Promise<RedisQueue> {
        if (!this.name) {
            throw new TypeError('No queue name provided!');
        }

        if (this.initialized) {
            return this;
        }

        // istanbul ignore next
        !this.watchCheckInterval && (this.watchCheckInterval = setInterval(
            async () => await this.ownWatch(),
            this.options.watcherCheckDelay
        ));

        const connPromises = [];

        // istanbul ignore next
        if (!this.reader) {
            connPromises.push(this.connect('reader', this.options));
        }

        if (!this.writer) {
            connPromises.push(this.connect('writer', this.options, RedisQueue));
        }

        await Promise.all(connPromises);

        if (!this.signalsInitialized) {
            const free = async () => {
                if (this.watchOwner) {
                    await this.unlock();
                }

                process.exit(0);
            };

            process.on('SIGTERM', free);
            process.on('SIGINT', free);
            process.on('exit', free);

            this.signalsInitialized = true;
        }

        if (!await this.watcherCount()) {
            if (await this.isLocked()) {
                await this.unlock();
            }

            await this.ownWatch();
        }

        this.read();

        this.processDelayed(`${this.options.prefix}:${this.name}`).catch();

        this.initialized = true;

        return this;
    }

    /**
     * Sends given message to a given queue (by name)
     *
     * @param {string} toQueue
     * @param {IJson} message
     * @param {number} [delay]
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async send(
        toQueue: string,
        message: IJson,
        delay?: number
    ): Promise<RedisQueue> {
        // istanbul ignore next
        if (!this.writer) {
            await this.start();
        }

        const id = uuid();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;
        const packet = this.pack(data);

        if (delay) {
            await Promise.all([
                this.writer.zadd(
                    `${key}:delayed`,
                    Date.now() + delay,
                    packet
                ),
                this.writer.set(`${key}:${id}:ttl`, '', 'PX', delay, 'NX')
            ]);
        }

        else {
            await this.writer.lpush(key, packet);
        }

        return this;
    }

    /**
     * Stops current queue routines
     *
     * @returns {Promise<RedisQueue>}
     */
    @profile()
    public async stop(): Promise<RedisQueue> {
        const self = this;

        self.reader && self.reader.unref();
        delete self.reader;

        this.initialized = false;

        return this;
    }

    /**
     * Gracefully destroys this queue
     *
     * @returns {Promise<void>}
     */
    @profile()
    public async destroy() {
        this.removeAllListeners();

        // istanbul ignore next
        if (this.watchCheckInterval) {
            clearInterval(this.watchCheckInterval);
            delete this.watchCheckInterval;
        }

        if (RedisQueue.writer) {
            RedisQueue.writer.unref();
            delete RedisQueue.writer;
        }

        if (this.watcher) {
            this.watcher.unref();
            this.watcher.removeAllListeners();
            delete this.watcher;
        }

        await this.stop();
    }

}
