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
    profile,
    uuid
} from '.';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as crypto from 'crypto';
import {ILogger} from "./IMessageQueue";

const DEFAULT_OPTIONS: IMQOptions = {
    host: 'localhost',
    port: 6379,
    prefix: 'imq',
    logger: console
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
 * Class RedisQueue
 * Implements simple messaging queue over redis.
 */
export class RedisQueue extends EventEmitter implements IMessageQueue {

    [name: string]: any;

    /**
     * @event message (message: IJson, id: string, from: string)
     */

    private reader: IRedisClient;
    private writer: IRedisClient;
    private watcher: IRedisClient;

    private initialized: boolean = false;
    private watchOwner = false;

    private get logger(): ILogger {
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

    /**
     * @constructor
     * @param {string} name
     * @param {IMQOptions} [options]
     */
    constructor(
        public name: string,
        public options: IMQOptions = DEFAULT_OPTIONS
    ) {
        super();

        if (options) {
            this.options = Object.assign(DEFAULT_OPTIONS, options);
        }
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
            context[channel].on('error', (err: Error) => {
                this.logger.error(`Error connecting redis on ${channel}:`, err);
                reject(err);
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
        const [queue, data] = message;

        if (!queue || queue !== this.key) {
            return this;
        }

        try {
            const { id, message, from } = JSON.parse(data);
            this.emit('message', message, id, from);
        }

        catch (err) {
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
    private async watcherCount(): Promise<number> {
        return (<any>await this.writer.client('list'))
            .split(/\r?\n/)
            .filter((client: string) =>
                /\s+name=[\S]+?:watcher:/.test(client)
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
        const self: any = this;

        if (!self.reader) {
            return this;
        }

        process.nextTick(async () => {
            while (true) {
                if (!self.reader) {
                    break;
                }

                this.process(await self.reader.brpop(this.key, 0));
            }
        });

        self.reader.brpop(this.key, 0).then(
            (message: [any, any]) => this.process(message).read()
        );

        return this;
    }

    /**
     * Checks if watcher connection is locked
     *
     * @access private
     * @returns {Promise<boolean>}
     */
    private async isLocked(): Promise<boolean> {
        return this.writer.exists(this.lockKey);
    }

    /**
     * Locks watcher connection
     *
     * @access private
     * @returns {Promise<number>}
     */
    private async lock(): Promise<number> {
        return <any>this.writer.setnx(this.lockKey, '');
    }

    /**
     * Unlocks watcher connection
     *
     * @access private
     * @returns {Promise<number>}
     */
    private async unlock(): Promise<number> {
        return <any>this.writer.del(this.lockKey);
    }

    /**
     * Aquires owner for watcher connection to this instance of the queue
     *
     * @returns {Promise<void>}
     */
    private async ownWatch() {
        if (await this.lock()) {
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
        if (this.initialized) {
            return this;
        }

        await Promise.all([
            this.connect('reader', this.options),
            this.connect('writer', this.options)
        ]);

        Object.keys(this.scripts).forEach(async (script: string) => {
            const checksum = this.scripts[script].checksum = sha1(
                this.scripts[script].code);

            if (!(<any>await this.writer.script('exists', checksum)).shift()) {
                await this.writer.script('load', this.scripts[script].code);
            }
        });

        const free = async () => {
            if (this.watchOwner) {
                await this.unlock();
            }

            process.exit(0);
        };

        process.on('SIGTERM', free);
        process.on('SIGINT', free);
        process.on('exit', free);

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
        const self = this;

        if (!self.writer) {
            return this;
        }

        const id = uuid();
        const data: IMessage = { id, message, from: this.name };
        const key = `${this.options.prefix}:${toQueue}`;

        if (delay) {
            await Promise.all([
                self.writer.zadd(
                    `${key}:delayed`,
                    Date.now() + delay,
                    JSON.stringify(data)
                ),
                self.writer.set(`${key}:${id}:ttl`, '', 'PX', delay, 'NX')
            ]);
        }

        else {
            await self.writer.lpush(key, JSON.stringify(data));
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

        self.reader.unref();
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
        const self = this;

        this.removeAllListeners();

        if (self.writer) {
            self.writer.unref();
            delete self.writer;
        }

        if (self.watcher) {
            self.watcher.unref();
            self.watcher.removeAllListeners();
            delete self.watcher;
        }

        await this.stop();
    }

}
