/*!
 * Message Queue factory for @imqueue/core
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
