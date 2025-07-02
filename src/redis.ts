/*!
 * Extends native redis module to be promise-like
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
