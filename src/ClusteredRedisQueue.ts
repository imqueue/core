/*!
 * Clustered messaging queue over Redis implementation
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
import {
    IMessageQueue,
    IJson,
    IMQOptions,
    DEFAULT_IMQ_OPTIONS,
    RedisQueue
} from '.';
import { EventEmitter } from 'events';

export class ClusteredRedisQueue implements IMessageQueue, EventEmitter {

    private imqs: RedisQueue[] = [];
    private options: IMQOptions;
    private mqOptions: IMQOptions;
    private servers: Array<{ host: string, port: number }> = [];
    private currentQueue = 0;
    private queueLength = 0;

    /**
     * Class constructor
     *
     * @constructor
     * @param {string} name
     * @param {Partial<IMQOptions>} options
     */
    constructor(
        public name: string,
        options?: Partial<IMQOptions>
    ) {
        this.options = Object.assign({}, DEFAULT_IMQ_OPTIONS, options || {});

        if (!this.options.cluster) {
            throw new TypeError('ClusteredRedisQueue: cluster ' +
                'configuration is missing!');
        }

        this.mqOptions = Object.assign({}, this.options);
        // istanbul ignore next
        this.servers = this.mqOptions.cluster || [];

        delete this.mqOptions.cluster;

        for (let i = 0, s = this.servers.length; i < s; i++) {
            const opts = Object.assign({}, this.mqOptions, this.servers[i]);
            this.imqs.push(new RedisQueue(this.name, opts));
        }

        this.queueLength = this.imqs.length;
    }

    /**
     * Starts the messaging queue.
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async start(): Promise<ClusteredRedisQueue> {
        const promises = [];

        for (let imq of this.imqs) {
             promises.push(imq.start());
        }

        await Promise.all(promises);

        return this;
    }

    /**
     * Stops the queue (should stop handle queue messages).
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async stop(): Promise<ClusteredRedisQueue> {
        const promises = [];

        for (let imq of this.imqs) {
            promises.push(imq.stop());
        }

        await Promise.all(promises);

        return this;
    }

    /**
     * Sends a message to given queue name with the given data.
     * Supposed to be an async function.
     *
     * @param {string} toQueue - queue name to which message should be sent to
     * @param {IJson} message - message data
     * @param {number} [delay] - if specified, message will be handled in the
     *                           target queue after specified period of time
     *                           in milliseconds.
     * @param {Function} [errorHandler] - callback called only when internal
     *                                    error occurs during message send
     *                                    execution.
     * @returns {Promise<string>} - message identifier
     */
    public async send(
        toQueue: string,
        message: IJson,
        delay?: number,
        errorHandler?: Function
    ): Promise<string> {
        if (this.currentQueue >= this.queueLength) {
            this.currentQueue = 0;
        }

        const imq: any = this.imqs[this.currentQueue];
        const id = await imq.send(toQueue, message, delay, errorHandler);

        this.currentQueue++;

        return id;
    }

    /**
     * Safely destroys current queue, unregistered all set event
     * listeners and connections.
     * Supposed to be an async function.
     *
     * @returns {Promise<void>}
     */
    public async destroy(): Promise<void> {
        const promises = [];

        for (let imq of this.imqs) {
            promises.push(imq.destroy());
        }

        await Promise.all(promises);
    }

    /**
     * Clears queue data in queue host application.
     * Supposed to be an async function.
     *
     * @returns {Promise<IMessageQueue>}
     */
    public async clear(): Promise<ClusteredRedisQueue> {
        const promises = [];

        for (let imq of this.imqs) {
            promises.push(imq.clear());
        }

        await Promise.all(promises);

        return this;
    }

    // EventEmitter interface

    // istanbul ignore next
    public on(...args: any[]) {
        for (let imq of this.imqs) {
            imq.on.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public off(...args: any[]) {
        for (let imq of this.imqs) {
            imq.off.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public once(...args: any[]) {
        for (let imq of this.imqs) {
            imq.once.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public addListener(...args: any[]) {
        for (let imq of this.imqs) {
            imq.addListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public removeListener(...args: any[]) {
        for (let imq of this.imqs) {
            imq.removeListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public removeAllListeners(...args: any[]) {
        for (let imq of this.imqs) {
            imq.removeAllListeners.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public prependListener(...args: any[]) {
        for (let imq of this.imqs) {
            imq.prependListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public prependOnceListener(...args: any[]) {
        for (let imq of this.imqs) {
            imq.prependListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public setMaxListeners(...args: any[]) {
        for (let imq of this.imqs) {
            imq.setMaxListeners.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public listeners(...args: any[]) {
        let listeners: any[] = [];
        for (let imq of this.imqs) {
            listeners = listeners.concat(imq.listeners.apply(imq, args));
        }

        return listeners;
    }

    // istanbul ignore next
    public rawListeners(...args: any[]) {
        let listeners: any[] = [];
        for (let imq of this.imqs) {
            listeners = listeners.concat(imq.rawListeners.apply(imq, args));
        }

        return listeners;
    }

    // istanbul ignore next
    public getMaxListeners() {
        return this.imqs[0].getMaxListeners();
    }

    // istanbul ignore next
    public emit(...args: any[]) {
        for (let imq of this.imqs) {
            imq.emit.apply(imq, args);
        }

        return true;
    }

    // istanbul ignore next
    public eventNames(...args: any[]) {
        return this.imqs[0].eventNames.apply(this.imqs[0], args);
    }

    // istanbul ignore next
    public listenerCount(...args: any[]) {
        return this.imqs[0].listenerCount.apply(this.imqs[0], args);
    }

}