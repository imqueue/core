/*!
 * Basic types and interfaces
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
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
import { EventEmitter } from 'events';

export interface IJson {
    [name: string]: number | string | boolean | null | IJson |
        number[] | string[] | boolean[] | null[] | IJson[];
}

export interface ILogger {
    log(...args: any[]): void,
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}

export type IMessage = {
    id: string,
    message: IJson,
    from: string,
    delay?: number
};

export type IMQOptions = {
    host: string,
    port: number,
    vendor?: string,
    prefix?: string,
    logger?: ILogger,
    watcherCheckDelay?: number,
    useGzip: boolean
};

export interface IMessageQueueConstructor {
    new (name: string, options?: Partial<IMQOptions>): IMessageQueue;
}

export interface IMessageQueue extends EventEmitter {
    /**
     * @event message (message: IJson, id: string, from: string)
     */

    start(): Promise<IMessageQueue>;

    stop(): Promise<IMessageQueue>;

    send(
        toQueue: string,
        message: IJson,
        delay?: number
    ): Promise<IMessageQueue>;

    destroy(): void;
}
