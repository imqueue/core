/*!
 * Redis client re-export and the internal client type augmentation
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
import { Redis } from 'ioredis';

/**
 * The ioredis `Redis` client type augmented with the two internal bookkeeping
 * flags imq stamps onto the connections it creates. Not intended for use as an
 * option or parameter type by consumers.
 */
export interface IRedisClient extends Redis {
    /**
     * Internal flag marking a watcher connection whose keyspace subscriptions
     * and maintenance interval have already been installed, so watcher setup
     * runs at most once per connection. Not part of the supported API.
     */
    __ready__?: boolean;
    /**
     * Internal marker stamped on every Redis connection created by the queue,
     * identifying it as imq-owned. Currently written but not read by the
     * framework. Not part of the supported API.
     */
    __imq?: boolean;
}

export { Redis };
export default Redis;
