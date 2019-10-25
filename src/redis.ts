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
import * as redis from 'redis';
import { promisify } from '.';

const commands: string[] = [...new Set<string>(
    require('redis-commands').list.map((name: string) => name.toLowerCase())
)].filter((name: string) => !~['stream', 'multi'].indexOf(name));

/**
 * Extends default RedisClient type to allow dynamic properties access on it
 *
 * @type {IRedisClient}
 */
export interface IRedisClient extends redis.RedisClient {
    [name: string]: any;
}

/**
 * Extends default Multi type to allow dynamic properties access on it
 *
 * @type {IMulti}
 */
export interface IMulti extends redis.Multi {
    [name: string]: any;
}

/**
 * Make redis interfaces promise-like to allow work with
 * them through async/await
 */
promisify((<any> redis).RedisClient.prototype, commands);
promisify((<any> redis).Multi.prototype, commands);

export { redis };
