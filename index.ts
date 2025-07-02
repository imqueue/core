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
import 'reflect-metadata';
import {
    IMessageQueue,
    IMessageQueueConstructor,
    IMQMode,
    IMQOptions,
} from './src';

export * from './src';

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

        const Adapter: IMessageQueueConstructor =
            require(`${__dirname}/src/${ClassName}.js`)[ClassName];

        return new Adapter(name, options, mode);
    }
}
