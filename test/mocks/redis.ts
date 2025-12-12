/*!
 * IMQ Unit Test Mocks: redis
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
    public status = 'ready';

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
    public quit() {
        return new Promise(resolve => resolve(undefined));
    }

    // noinspection JSMethodCanBeStatic
    public set(...args: any[]): Promise<number> {
        const [key, val] = args;
        RedisClientMock.__keys[key] = val;
        this.cbExecute(args.pop(), null, 1);
        return new Promise(resolve => resolve(1));
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
    public psubscribe(...args: any[]): Promise<number> {
        this.cbExecute(args.pop(), null, 1);
        return new Promise(resolve => resolve(1));
    }

    public punsubscribe(...args: any[]): Promise<number> {
        this.cbExecute(args.pop(), null, 1);
        return new Promise(resolve => resolve(1));
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public evalsha(...args: any[]): boolean {
        this.cbExecute(args.pop());
        return true;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public del(...args: any[]): Promise<number> {
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
        return new Promise(resolve => resolve(count));
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
    public publish(channel: string, message: string, cb?: any): number {
        this.cbExecute(cb, null, 1);
        return 1;
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public subscribe(channel: string, cb?: any): void {
        this.cbExecute(cb, null, 1);
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public unsubscribe(channel?: string, cb?: any): void {
        this.cbExecute(cb, null, 1);
    }

    // noinspection JSUnusedGlobalSymbols,JSMethodCanBeStatic
    public config(): Promise<boolean> {
        return new Promise(resolve => resolve(true));
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
