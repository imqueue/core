/*!
 * Clustered messaging queue over Redis implementation
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
import { EventEmitter } from 'events';
import {
    DEFAULT_IMQ_DYNAMIC_CLUSTER_OPTIONS,
    DEFAULT_IMQ_OPTIONS,
    buildOptions,
    IDynamicCluster,
    ILogger,
    IMessageQueue,
    IMessageQueueConnection,
    IMQMode,
    IMQOptions,
    JsonObject,
    RedisQueue,
} from '.';
import * as dgram from 'dgram';
import { selectNetworkInterface } from './selectNetworkInterface';

enum DynamicClusterMessageType {
    Up = 'up',
    Down = 'down',
}

interface DynamicClusterMessage {
    name: string;
    id: string;
    type: DynamicClusterMessageType;
    host: string;
    port: number;
    timeout: number;
}

interface ClusterServer extends IMessageQueueConnection {
    id?: string;
    imq?: RedisQueue;
}

/**
 * Class ClusteredRedisQueue
 * Implements possibility to scale queues horizontally between several
 * redis instances.
 */
export class ClusteredRedisQueue implements IMessageQueue, EventEmitter {

    /**
     * Logger instance associated with this queue instance
     *
     * @type {ILogger}
     */
    public logger: ILogger;

    /**
     * RedisQueue instances collection
     *
     * @type {RedisQueue[]}
     */
    private imqs: RedisQueue[] = [];

    /**
     * Options associated with this queue instance
     *
     * @type {IMQOptions}
     */
    private readonly options: IMQOptions;

    /**
     * Part of options without cluster definitions - which are generic for
     * RedisQueue instances
     *
     * @type {IMQOptions}
     */
    private readonly mqOptions: IMQOptions;

    /**
     * Cluster servers option definitions
     *
     * @type {IMessageQueueConnection[]}
     */
    // tslint:disable-next-line:completed-docs
    private servers: ClusterServer[] = [];

    /**
     * Current queue index (round-robin)
     *
     * @type {number}
     */
    private currentQueue: number = 0;

    // noinspection TypeScriptFieldCanBeMadeReadonly
    /**
     * Total length of RedisQueue instances
     *
     * @type {number}
     */
    private queueLength: number = 0;

    /**
     * Class constructor
     *
     * @constructor
     * @param {string} name
     * @param {Partial<IMQOptions>} options
     * @param {IMQMode} [mode]
     */
    public constructor(
        public name: string,
        options?: Partial<IMQOptions>,
        mode: IMQMode = IMQMode.BOTH,
    ) {
        this.options = buildOptions<IMQOptions>(DEFAULT_IMQ_OPTIONS, options);

        // istanbul ignore next
        this.logger = this.options.logger || console;

        if (!this.options.cluster && !this.options.dynamicCluster?.enabled) {
            throw new TypeError('ClusteredRedisQueue: cluster ' +
                'configuration is missing!');
        }

        if (this.options.dynamicCluster?.enabled) {
            this.initializeDC(this.options.dynamicCluster);
        }

        this.mqOptions = { ...this.options };

        const cluster = [...(this.mqOptions.cluster || [])];

        delete this.mqOptions.cluster;

        if (cluster.length) {
            this.addServers(cluster);
        }
    }

    /**
     * Starts the messaging queue.
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async start(): Promise<ClusteredRedisQueue> {
        return await this.batch('start',
            'Starting clustered redis message queue...');
    }

    /**
     * Stops the queue (should stop handle queue messages).
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async stop(): Promise<ClusteredRedisQueue> {
        return await this.batch('stop',
            'Stopping clustered redis message queue...');
    }

    /**
     * Sends a message to given queue name with the given data.
     * Supposed to be an async function.
     *
     * @param {string} toQueue - queue name to which message should be sent to
     * @param {JsonObject} message - message data
     * @param {number} [delay] - if specified, message will be handled in the
     *        target queue after specified period of time in milliseconds.
     * @param {(err: Error) => void} [errorHandler] - callback called only when
     *        internal error occurs during message send execution.
     * @returns {Promise<string>} - message identifier
     */
    public async send(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
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
        await this.batch('destroy',
            'Destroying clustered redis message queue...');
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Clears queue data in queue host application.
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async clear(): Promise<ClusteredRedisQueue> {
        return await this.batch('clear',
            'Clearing clustered redis message queue...');
    }

    /**
     * Batch imq action processing on all registered imqs at once
     *
     * @access private
     * @param {string} action
     * @param {string} message
     * @return {Promise<this>}
     */
    private async batch(action: string, message: string): Promise<this> {
        this.logger.log(message);

        const promises = [];

        for (const imq of this.imqs) {
            promises.push(imq[action]());
        }

        await Promise.all(promises);

        return this;
    }

    /* tslint:disable */
    // EventEmitter interface
    // istanbul ignore next
    public on(...args: any[]) {
        for (let imq of this.imqs) {
            imq.on.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    // noinspection JSUnusedGlobalSymbols
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
            imq.prependOnceListener.apply(imq, args);
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
        let rawListeners: any[] = [];
        for (let imq of this.imqs) {
            rawListeners = rawListeners.concat(imq.rawListeners.apply(imq, args));
        }

        return rawListeners;
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

    // istanbul ignore next
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        const promises = [] as Array<Promise<void>>;

        for (let imq of this.imqs) {
            promises.push(imq.publish(data, toName));
        }

        await Promise.all(promises);
    }

    // istanbul ignore next
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => any,
    ): Promise<void> {
        const promises = [] as Array<Promise<void>>;

        for (let imq of this.imqs) {
            promises.push(imq.subscribe(channel, handler));
        }

        await Promise.all(promises);
    }

    // istanbul ignore next
    public async unsubscribe(): Promise<void> {
        const promises = [] as Array<Promise<void>>;

        for (let imq of this.imqs) {
            promises.push(imq.unsubscribe());
        }

        await Promise.all(promises);
    }

    private addServers(
        servers: ClusterServer[],
        initializeQueues = false,
    ): void {
        for (let i = 0, s = servers.length; i < s; i++) {
            const opts = { ...this.mqOptions, ...servers[i] };
            const imq = new RedisQueue(this.name, opts);

            servers[i].imq = imq;
            this.imqs.push(imq);

            if (initializeQueues) {
                //TODO: initialize newly added queues
            }
        }

        this.servers.push(...servers);
        this.queueLength = this.imqs.length;
    }

    private removeServer(server: ClusterServer): void {
        const remove = this.findServer(server);

        if (!remove) {
            return;
        }

        this.servers = this.servers.filter(
            existing => ClusteredRedisQueue.matchServers(
                existing,
                server,
            ),
        );

        if (remove.imq) {
            this.imqs = this.imqs.filter(imq => remove.imq === imq);
            remove.imq.destroy();
        }

        this.queueLength = this.imqs.length;
    }

    private serverAdded(server: ClusterServer): boolean {
        if (!this.servers.length) {
            return false
        }

        return Boolean(this.findServer(server));
    }

    private findServer(server: ClusterServer): ClusterServer | undefined {
        return this.servers.find(
            existing => ClusteredRedisQueue.matchServers(
                existing,
                server,
            ),
        );
    }

    private static matchServers(
        target: ClusterServer,
        source: ClusterServer,
    ): boolean {
        if (target.id === source.id) {
            return true;
        }

        if (!target.id && !source.id) {
            return target.host === source.host
                && target.port === source.port;
        }

        return false;
    }

    private initializeDC(options: IDynamicCluster = {}): void {
        const initialOptions: IDynamicCluster = {
            ...DEFAULT_IMQ_DYNAMIC_CLUSTER_OPTIONS,
            ...options,
        };

        this.listenToDC(this.processDCMessage, initialOptions);
    }

    private processDCMessage(message: DynamicClusterMessage): void {
        const added = this.serverAdded(message);

        if (added && message.type === DynamicClusterMessageType.Down) {
            return this.removeServer(message);
        }

        if (!added && message.type === DynamicClusterMessageType.Up) {
            return this.addServers([message]);
        }
    }

    private listenToDC(
        listener: (message: DynamicClusterMessage) => void,
        options: IDynamicCluster,
    ): void {
        const socket = dgram.createSocket('udp4');

        socket
            .on(
                'message',
                message => listener(this.parseDCMessage(message)),
            )
            .bind(
                options.broadcastPort,
                selectNetworkInterface(options),
            )
        ;
    }

    private parseDCMessage(msg: Buffer): DynamicClusterMessage {
        const [
            name,
            id,
            type,
            address = '',
            timeout = '0',
        ] = msg.toString().split('\t');
        const [host, port] = address.split(':');

        return {
            name,
            id,
            type: type.toLowerCase() as DynamicClusterMessageType,
            host,
            port: parseInt(port),
            timeout: parseFloat(timeout),
        };
    }
}
