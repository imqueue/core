/*!
 * IMQ Unit Test Mocks: redis
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
import * as mock from 'mock-require';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

function sha1(str: string) {
    let sha: crypto.Hash = crypto.createHash('sha1');
    sha.update(str);
    return sha.digest('hex');
}

export class RedisClientMock extends EventEmitter {
    private static __queues__: any = {};
    private static __clientList: any = {};
    private __rt: any;
    private static __keys: any = {};
    private static __scripts: any = {};
    private __name: string = '';

    constructor(...args: any[]) {
        super();
        setTimeout(() => {
            this.emit('ready', this);
        });
    }

    set(...args: any[]) {
        const [key, val] = args;
        RedisClientMock.__keys[key] = val;
        args.pop()(null, 1);
    }

    setnx(...args: any[]) {
        const self = RedisClientMock;
        const key = args.shift();
        let result = 0;
        if (/:watch:lock$/.test(key)) {
            if (typeof self.__keys[key] === 'undefined') {
                self.__keys[key] = args.shift();
                result = 1;
            }
        }
        args.pop()(null, result);
    }

    lpush(key: string, value: any, cb?: any) {
        const self = RedisClientMock;
        if (!self.__queues__[key]) {
            self.__queues__[key] = [];
        }
        self.__queues__[key].push(value);
        cb(null, 1);
    }

    brpop(key: string, timeout?: number, cb?: Function) {
        const q = RedisClientMock.__queues__[key] || [];
        if (!q.length) {
            this.__rt && clearTimeout(this.__rt);
            this.__rt = setTimeout(() => this.brpop(
                key, timeout, cb
            ), timeout || 100);
        } else {
            cb && cb(null, [key, q.shift()]);
        }
    }

    brpoplpush(from: string, to: string, timeout: number, cb?: Function) {
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
    }

    lrange(key: string, start: number, stop: number, cb?: Function) {
        const q = RedisClientMock.__queues__[key] =
            RedisClientMock.__queues__[key] || [];
        cb && cb(null, q.splice(start, stop)[0]);
    }

    scan(...args: any[]) {
        const qs = RedisClientMock.__queues__;
        const found: string[] = [];
        for (let q of Object.keys(qs)) {
            if (q.match(/worker/)) {
                found.push(q);
            }
        }
        return ['0', found];
    }

    script(...args: any[]) {
        const cmd = args.shift();
        const script = args.shift();
        let hash: any = '';
        if (cmd === 'load') {
            hash = sha1(script);
            RedisClientMock.__scripts[hash] = script;
        }
        if (cmd === 'exists') {
            hash = RedisClientMock.__scripts[hash] !== undefined;
        }
        args.pop()(null, hash);
    }

    client(...args: any[]) {
        const self = RedisClientMock;
        const cb = args.pop();
        const cmd = args.shift();
        const name = args.shift();
        if (cmd === 'list') {
            return cb(null, Object.keys(self.__clientList)
                .map((name: string, id: number) => `id=${id} name=${name}`)
                .join('\n'));
        }
        else if (cmd === 'setname') {
            this.__name = name;
            self.__clientList[name] = true;
        }

        cb(null, true);
    }

    exists(...args: any[]) {
        const key = args.shift();
        args.pop()(null, RedisClientMock.__keys[key] !== undefined);
    }

    psubscribe(...args: any[]) {
        args.pop()(null, 1);
    }

    evalsha(...args: any[]) {
        args.pop()();
    }

    del(...args: any[]) {
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
    }

    zadd(key: string, score: number, value: string, cb?: Function) {
        const timeout = score - Date.now();
        setTimeout(() => {
            const toKey = key.split(/:/).slice(0,2).join(':');
            this.lpush(toKey, value);
        }, timeout);
        cb && cb();
    }

    unref(...args: any[]) {
        delete RedisClientMock.__clientList[this.__name];
        if (this.__rt) {
            clearTimeout(this.__rt);
            delete this.__rt;
        }
    }

    config(...args: any[]) {}
}

export class RedisMultiMock {}

mock('redis', {
    createClient() { return new RedisClientMock() },
    RedisClient: RedisClientMock,
    Multi: RedisMultiMock
});

export * from 'redis';
