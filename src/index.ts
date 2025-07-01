/*!
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
// noinspection JSUnusedGlobalSymbols
/**
 * Safely builds full options definition using default options and
 * partial given options
 *
 * @template T
 * @param {T} defaultOptions
 * @param {Partial<T>} givenOptions
 * @return {T}
 */
// istanbul ignore next
export function buildOptions<T>(
    defaultOptions: T,
    givenOptions?: Partial<T>,
): T {
    return Object.assign({}, defaultOptions, givenOptions);
}

export * from './IMQMode';
export * from './profile';
export * from './uuid';
export * from './promisify';
export * from './redis';
export * from './IMessageQueue';
export * from './RedisQueue';
export * from './ClusteredRedisQueue';
export * from './UDPClusterManager';
export * from './copyEventEmitter';
