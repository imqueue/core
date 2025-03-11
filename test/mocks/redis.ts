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

    constructor() {
        super();
        setTimeout(() => {
            this.emit('ready', this);
        });
    }

    // noinspection JSUnusedGlobalSymbols
    public end() {}
    // noinspection JSUnusedGlobalSymbols
    public quit() {}

    // noinspection JSMethodCanBeStatic
    public set(...args: any[]): boolean {
        const [key, val] = args;
        RedisClientMock.__keys[key] = val;
        args.pop()(null, 1);
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public setnx(...args: any[]): boolean {
        const self = RedisClientMock;
        const key = args.shift();
        let result = 0;
        if (/:watch:lock$/.test(key)) {
            if (typeof self.__keys[key] === 'undefined') {
                self.__keys[key] = args.shift();
                result = 1;
            }
        }
        const cb = args.pop()
        const isCb = typeof cb === 'function';

        isCb && cb(null, result);

        return true;
    }

    // noinspection TypescriptExplicitMemberType,JSMethodCanBeStatic
    public lpush(key: string, value: any, cb?: any): boolean {
        const self = RedisClientMock;
        if (!self.__queues__[key]) {
            self.__queues__[key] = [];
        }
        self.__queues__[key].push(value);
        const isCb = typeof cb === 'function';
        isCb && cb(null, 1);
        return true;
    }

    public brpop(...args: any[]): boolean {
        const [key, timeout, cb] = args;
        const q = RedisClientMock.__queues__[key] || [];
        if (!q.length) {
            this.__rt && clearTimeout(this.__rt);
            this.__rt = setTimeout(() => this.brpop(
                key, timeout, cb
            ), timeout || 100);
        } else {
            cb && cb(null, [key, q.shift()]);
        }
        return true;
    }

    public brpoplpush(
        from: string,
        to: string,
        timeout: number,
        cb?: Function
    ): boolean {
        const fromQ = RedisClientMock.__queues__[from] =
            RedisClientMock.__queues__[from] || [];
        const toQ = RedisClientMock.__queues__[to] =
            RedisClientMock.__queues__[to] || [];
        if (!fromQ.length) {
            this.__rt && clearTimeout(this.__rt);
            this.__rt = setTimeout(() => this.brpoplpush(
                from, to, timeout, cb
            ), timeout || 100);
        } else {
            toQ.push(fromQ.shift());
            cb && cb(null, '1');
        }
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public lrange(
        key: string,
        start: number,
        stop: number,
        cb?: Function
    ): boolean {
        const q = RedisClientMock.__queues__[key] =
            RedisClientMock.__queues__[key] || [];
        cb && cb(null, q.splice(start, stop));
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public scan(...args: any[]): boolean {
        const cb = args.pop();
        const qs = RedisClientMock.__queues__;
        const found: string[] = [];
        for (let q of Object.keys(qs)) {
            if (q.match(/worker/)) {
                found.push(q);
            }
        }
        cb && cb(null, ['0', found]);
        return true;
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

        return ;
    }

    // noinspection JSUnusedGlobalSymbols
    public client(...args: any[]): boolean {
        const self = RedisClientMock;
        const cmd = args.shift();
        const cb = args.pop();
        const name = args.shift();
        const isCb = typeof cb === 'function';

        if (cmd === 'LIST') {
            return isCb && cb(null, Object.keys(self.__clientList)
                .map((name: string, id: number) => `id=${id} name=${name}`)
                .join('\n'));
        }
        else if (cmd === 'SETNAME') {
            this.__name = name;
            self.__clientList[name] = true;
        }

        isCb && cb(null, true);
        return true;
    }

    // noinspection JSMethodCanBeStatic
    public exists(...args: any[]): boolean {
        const key = args.shift();
        args.pop()(null, RedisClientMock.__keys[key] !== undefined);
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public psubscribe(...args: any[]): boolean {
        args.pop()(null, 1);
        return true;
    }

    public punsubscribe(...args: any[]): boolean {
        args.pop()(null, 1);
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public evalsha(...args: any[]): boolean {
        args.pop()();
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public del(...args: any[]): boolean {
        const self = RedisClientMock;
        const cb = args.pop();
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
        cb(null, count);
        return true;
    }

    // noinspection JSUnusedGlobalSymbols
    public zadd(...args: any[]): boolean {
        const [key, score, value, cb] = args;
        const timeout = score - Date.now();
        setTimeout(() => {
            const toKey = key.split(/:/).slice(0,2).join(':');
            this.lpush(toKey, value);
        }, timeout);
        cb && cb();
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
}

mock('ioredis', {
    default: RedisClientMock,
    Redis: RedisClientMock,
});

export * from 'ioredis';
