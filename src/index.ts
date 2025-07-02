/*!
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
