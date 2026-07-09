/*!
 * Message Queue factory for @imqueue/core
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
import {
    type IMessageQueue,
    type IMessageQueueConstructor,
    IMQMode,
    type IMQOptions,
} from './src/index.js';
import { ClusteredRedisQueue } from './src/index.js';
import { RedisQueue } from './src/index.js';

export * from './src/index.js';

// ES modules provide no synchronous dynamic loading, so the queue adapters
// are registered statically; the map key matches the previously used
// `${vendor}Queue` / `Clustered${vendor}Queue` file naming convention
const ADAPTERS: { [name: string]: IMessageQueueConstructor } = {
    RedisQueue: RedisQueue as unknown as IMessageQueueConstructor,
    ClusteredRedisQueue:
        ClusteredRedisQueue as unknown as IMessageQueueConstructor,
};

/**
 * Message Queue Factory
 */
export default class IMQ {
    /**
     * Base generic queue factory options
     *
     * @type {Partial<IMQOptions>}
     */
    private static options: Partial<IMQOptions> = {
        vendor: 'Redis', // default vendor
    };

    /**
     * Instantiate proper message queue instance using given user-options
     *
     * @param {string} name
     * @param {IMQOptions} options
     * @param {IMQMode} mode
     * @return {IMessageQueue}
     */
    public static create(
        name: string,
        options: Partial<IMQOptions> = {},
        mode: IMQMode = IMQMode.BOTH,
    ): IMessageQueue {
        options = Object.assign({}, IMQ.options, options);

        let ClassName = `${options.vendor}Queue`;

        if (options.cluster || options.clusterManagers) {
            ClassName = `Clustered${ClassName}`;
        }

        const Adapter: IMessageQueueConstructor | undefined =
            ADAPTERS[ClassName];

        if (!Adapter) {
            throw new TypeError(`IMQ: unknown queue vendor requested: ${
                options.vendor}`);
        }

        return new Adapter(name, options, mode);
    }
}
