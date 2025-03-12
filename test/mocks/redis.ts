/*!
 * IMQ Unit Test Mocks: redis
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
import * as mock from 'mock-require';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

function sha1(str: string) {
    let sha: crypto.Hash = crypto.createHash('sha1');
    sha.update(str);
    return sha.digest('hex');
}

/**
 * @implements {IRedisClient}
 */
export class RedisClientMock extends EventEmitter {
    private static __queues__: any = {};
    private static __clientList: any = {};
    private __rt: any;
    private static __keys: any = {};
    private static __scripts: any = {};
    private __name: string = '';
    // noinspection JSUnusedGlobalSymbols
    public connected: boolean = true;

    constructor(options: any = {}) {
        super();
        setTimeout(() => {
            this.emit('ready', this);
        });

        if (options.connectionName) {
            this.__name = options.connectionName;
            RedisClientMock.__clientList[options.connectionName] = true;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    public end() {}
    // noinspection JSUnusedGlobalSymbols
    public quit() {}

    // noinspection JSMethodCanBeStatic
    public set(...args: any[]): number {
        const [key, val] = args;
        RedisClientMock.__keys[key] = val;
        this.cbExecute(args.pop(), null, 1);
        return 1;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public setnx(...args: any[]): number {
        const self = RedisClientMock;
        const key = args.shift();
        let result = 0;
        if (/:watch:lock$/.test(key)) {
            if (typeof self.__keys[key] === 'undefined') {
                self.__keys[key] = args.shift();
                result = 1;
            }
        }

        this.cbExecute(args.pop(), null, result);

        return result;
    }

    // noinspection TypescriptExplicitMemberType,JSMethodCanBeStatic
    public lpush(key: string, value: any, cb?: any): number {
        const self = RedisClientMock;
        if (!self.__queues__[key]) {
            self.__queues__[key] = [];
        }
        self.__queues__[key].push(value);
        this.cbExecute(cb, null, 1);
        return 1;
    }

    public async brpop(...args: any[]): Promise<string[]> {
        const [key, timeout, cb] = args;
        const q = RedisClientMock.__queues__[key] || [];
        if (!q.length) {
            this.__rt && clearTimeout(this.__rt);

            return new Promise(resolve => {
                this.__rt = setTimeout(() => resolve(this.brpop(
                    key, timeout, cb,
                )), timeout || 100);
            });
        } else {
            const result = [key, q.shift()];

            this.cbExecute(cb, null, [key, q.shift()]);

            return result;
        }
    }

    public async brpoplpush(
        from: string,
        to: string,
        timeout: number,
        cb?: Function
    ): Promise<string> {
        const fromQ = RedisClientMock.__queues__[from] =
            RedisClientMock.__queues__[from] || [];
        const toQ = RedisClientMock.__queues__[to] =
            RedisClientMock.__queues__[to] || [];
        if (!fromQ.length) {
            this.__rt && clearTimeout(this.__rt);

            return new Promise(resolve => {
                this.__rt = setTimeout(() => resolve(this.brpoplpush(
                    from, to, timeout, cb,
                )), timeout || 100);
            });
        } else {
            toQ.push(fromQ.shift());
            cb && cb(null, '1');

            return '1';
        }
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public lrange(
        key: string,
        start: number,
        stop: number,
        cb?: Function,
    ): boolean {
        const q = RedisClientMock.__queues__[key] =
            RedisClientMock.__queues__[key] || [];
        const result = q.splice(start, stop);
        this.cbExecute(cb, null, result);
        return result;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public scan(...args: any[]): (string | string[])[] {
        const cb = args.pop();
        const qs = RedisClientMock.__queues__;
        const found: string[] = [];
        for (let q of Object.keys(qs)) {
            if (q.match(/worker/)) {
                found.push(q);
            }
        }
        const result = ['0', found];
        this.cbExecute(cb, null, result);
        return result;
    }

    // noinspection JSMethodCanBeStatic
    public script(...args: any[]): unknown {
        const cmd = args.shift();
        const scriptOrHash = args.shift();
        const cb = args.pop();
        const isCb = typeof cb === 'function';

        if (cmd === 'LOAD') {
            const hash = sha1(scriptOrHash);
            RedisClientMock.__scripts[hash] = scriptOrHash;
            isCb && cb(null, hash);
            return hash;
        }
        if (cmd === 'EXISTS') {
            const hash = RedisClientMock.__scripts[scriptOrHash] !== undefined;

            isCb && cb(null, hash);

            return [Number(hash)];
        }

        return [0];
    }

    // noinspection JSUnusedGlobalSymbols
    public client(...args: any[]): string | boolean {
        const self = RedisClientMock;
        const cmd = args.shift();
        const cb = args.pop();
        const name = args.shift();

        if (cmd === 'LIST') {
            const result = Object.keys(self.__clientList)
                .map((name: string, id: number) => `id=${id} name=${name}`)
                .join('\n');

            this.cbExecute(cb, null, result);
            return result;
        }
        else if (cmd === 'SETNAME') {
            this.__name = name;
            self.__clientList[name] = true;
        }

        this.cbExecute(cb, null, true);
        return true;
    }

    // noinspection JSMethodCanBeStatic
    public exists(...args: any[]): boolean {
        const key = args.shift();
        const result = RedisClientMock.__keys[key] !== undefined;
        this.cbExecute(args.pop(), null, result);
        return result;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public psubscribe(...args: any[]): number {
        this.cbExecute(args.pop(), null, 1);
        return 1;
    }

    public punsubscribe(...args: any[]): number {
        this.cbExecute(args.pop(), null, 1);
        return 1;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public evalsha(...args: any[]): boolean {
        this.cbExecute(args.pop());
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public del(...args: any[]): number {
        const self = RedisClientMock;
        let count = 0;
        for (let key of args) {
            if (self.__keys[key] !== undefined) {
                delete self.__keys[key];
                count++;
            }
            if (self.__queues__[key] !== undefined) {
                delete self.__queues__[key];
                count++;
            }
        }
        this.cbExecute(args.pop(), count);
        return count;
    }

    // noinspection JSUnusedGlobalSymbols
    public zadd(...args: any[]): boolean {
        const [key, score, value, cb] = args;
        const timeout = score - Date.now();
        setTimeout(() => {
            const toKey = key.split(/:/).slice(0,2).join(':');
            this.lpush(toKey, value);
        }, timeout);
        this.cbExecute(cb);
        return true;
    }

    // noinspection JSUnusedGlobalSymbols
    public disconnect(): boolean {
        delete RedisClientMock.__clientList[this.__name];
        if (this.__rt) {
            clearTimeout(this.__rt);
            delete this.__rt;
        }
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public config(): boolean {
        return true;
    }

    private cbExecute(cb: any, ...args: any[]): void {
        if (typeof cb === 'function') {
            cb(...args);
        }
    }
}

mock('ioredis', {
    default: RedisClientMock,
    Redis: RedisClientMock,
});

export * from 'ioredis';
