/*!
 * Extends native redis module to be promise-like
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
/* tslint:disable */
import Redis from 'ioredis';

/**
 * Extends default Redis  type to allow dynamic properties access on it
 *
 * @type {IRedisClient}
 */
export interface IRedisClient extends Redis {
    __ready__?: boolean;
    __imq?: boolean;
}

// istanbul ignore next
export function makeRedisSafe(redis: IRedisClient): IRedisClient {
    return new Proxy(redis, {
        get(target, property, receiver) {
            const original = Reflect.get(target, property, receiver);

            if (typeof original === 'function') {
                return async (...args: unknown[]) => {
                    try {
                        if (target.status !== 'ready') {
                            return null;
                        }

                        return await original.apply(target, args);
                    } catch (err: unknown) {
                        return null;
                    }
                };
            }

            return original;
        },
    });
}

export { Redis };
export default Redis;
