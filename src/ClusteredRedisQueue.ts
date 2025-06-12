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
    DEFAULT_IMQ_OPTIONS,
    buildOptions,
    ILogger,
    IMessageQueue,
    IMessageQueueConnection,
    IMQMode,
    IMQOptions,
    JsonObject,
    RedisQueue,
    EventMap,
    IServerInput,
} from '.';
import { copyEventEmitter } from './utils';

interface ClusterServer extends IMessageQueueConnection {
    imq?: RedisQueue;
}

interface ClusterState {
    started: boolean;
    subscriptions: {
        channel: string;
        handler: (data: JsonObject) => any;
    }[];
}

/**
 * Class ClusteredRedisQueue
 *  Implements the possibility to scale queues horizontally between several
 * redis instances.
 */
export class ClusteredRedisQueue implements IMessageQueue,
    EventEmitter<EventMap> {

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
     * Template EventEmitter instance used to replicate queue EventEmitters when
     * dynamically modifying the cluster
     * @type {EventEmitter}
     * @private
     */
    private readonly templateEmitter: EventEmitter;

    /**
     * Cluster EventEmitter instance used to notify about changes of
     * cluster servers
     * @type {EventEmitter}
     * @private
     */
    private readonly clusterEmitter: EventEmitter;

    private state: ClusterState = {
        started: false,
        subscriptions: [],
    };

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
        this.templateEmitter = new EventEmitter();
        this.clusterEmitter = new EventEmitter();
        this.options = buildOptions<IMQOptions>(DEFAULT_IMQ_OPTIONS, options);

        // istanbul ignore next
        this.logger = this.options.logger || console;

        if (!this.options.cluster && !this.options.clusterManagers?.length) {
            throw new TypeError('ClusteredRedisQueue: cluster ' +
                'configuration is missing!');
        }

        this.mqOptions = { ...this.options };

        const cluster = [...this.mqOptions.cluster || []];

        delete this.mqOptions.cluster;

        for (const server of cluster) {
            this.addServerWithQueueInitializing(server, false);
        }

        if (this.options.clusterManagers?.length) {
            for (const manager of this.options.clusterManagers) {
                manager.init({
                    add: this.addServer.bind(this),
                    remove: this.removeServer.bind(this),
                    exists: this.findServer.bind(this),
                });
            }
        }
    }

    /**
     * Starts the messaging queue.
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async start(): Promise<ClusteredRedisQueue> {
        this.state.started = true;

        return await this.batch('start',
            'Starting clustered redis message queue...');
    }

    /**
     * Stops the queue (should stop handling queue messages).
     * Supposed to be an async function.
     *
     * @returns {Promise<ClusteredRedisQueue>}
     */
    public async stop(): Promise<ClusteredRedisQueue> {
        this.state.started = false;

        return await this.batch('stop',
            'Stopping clustered redis message queue...');
    }

    /**
     * Sends a message to given queue name with the given data.
     * Supposed to be an async function.
     *
     * @param {string} toQueue - queue name to which message should be sent to
     * @param {JsonObject} message - message data
     * @param {number} [delay] - if specified, a message will be handled in the
     *        target queue after a specified period of time in milliseconds.
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
        if (!this.queueLength) {
            return await new Promise(resolve => this.clusterEmitter.once(
                'initialized',
                async ({ imq }) => {
                    resolve(await imq.send(
                        toQueue,
                        message,
                        delay,
                        errorHandler,
                    ));
                },
            ));
        }

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
        this.state.started = false;

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
        for (const imq of this.eventEmitters()) {
            imq.on.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    // noinspection JSUnusedGlobalSymbols
    public off(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.off.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public once(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.once.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public addListener(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.addListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public removeListener(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.removeListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public removeAllListeners(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.removeAllListeners.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public prependListener(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.prependListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public prependOnceListener(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.prependOnceListener.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public setMaxListeners(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.setMaxListeners.apply(imq, args);
        }

        return this;
    }

    // istanbul ignore next
    public listeners(...args: any[]) {
        let listeners: any[] = [];

        for (const imq of this.eventEmitters()) {
            listeners = listeners.concat(imq.listeners.apply(imq, args));
        }

        return listeners;
    }

    // istanbul ignore next
    public rawListeners(...args: any[]) {
        let rawListeners: any[] = [];

        for (const imq of this.eventEmitters()) {
            rawListeners = rawListeners.concat(
                imq.rawListeners.apply(imq, args),
            );
        }

        return rawListeners;
    }

    // istanbul ignore next
    public getMaxListeners() {
        return this.templateEmitter.getMaxListeners();
    }

    // istanbul ignore next
    public emit(...args: any[]) {
        for (const imq of this.eventEmitters()) {
            imq.emit.apply(imq, args);
        }

        return true;
    }

    // istanbul ignore next
    public eventNames(...args: any[]) {
        return this.templateEmitter.eventNames.apply(this.imqs[0], args);
    }

    // istanbul ignore next
    public listenerCount(...args: any[]) {
        return this.templateEmitter.listenerCount.apply(this.imqs[0], args);
    }

    // istanbul ignore next
    public async publish(data: JsonObject, toName?: string): Promise<void> {
        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.publish(data, toName));
        }

        await Promise.all(promises);
    }

    // istanbul ignore next
    public async subscribe(
        channel: string,
        handler: (data: JsonObject) => any,
    ): Promise<void> {
        this.state.subscriptions.push({ channel, handler });

        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.subscribe(channel, handler));
        }

        await Promise.all(promises);
    }

    // istanbul ignore next
    public async unsubscribe(): Promise<void> {
        this.state.subscriptions = [];

        const promises: Array<Promise<void>> = [];

        for (const imq of this.imqs) {
            promises.push(imq.unsubscribe());
        }

        await Promise.all(promises);
    }

    /**
     * Adds new servers to the cluster
     *
     * @param {IServerInput} server
     * @returns {void}
     */
    protected addServer(server: IServerInput): void {
        return this.addServerWithQueueInitializing(server, true);
    }

    /**
     * Removes server from the cluster
     *
     * @param {IServerInput} server
     * @returns {void}
     */
    protected removeServer(server: IServerInput): void {
        const remove = this.findServer(server);

        if (!remove) {
            return;
        }

        if (remove.imq) {
            this.imqs = this.imqs.filter(imq => remove.imq !== imq);
            remove.imq.destroy().catch();
        }

        this.clusterEmitter.emit('remove', {
            server: remove,
            imq: remove.imq,
        });

        this.queueLength = this.imqs.length;
        this.servers = this.servers.filter(
            existing => ClusteredRedisQueue.matchServers(
                existing,
                server,
            ),
        );
    }

    private addServerWithQueueInitializing(
        server: ClusterServer,
        initializeQueue: boolean = true,
    ): void {
        const newServer: ClusterServer = {
            id: server.id,
            host: server.host,
            port: server.port,
        };
        const opts = { ...this.mqOptions, ...newServer };
        const imq = new RedisQueue(this.name, opts);

        if (initializeQueue) {
            this.initializeQueue(imq)
                .then(() => {
                    this.clusterEmitter.emit('initialized', {
                        server: newServer,
                        imq,
                    });
                })
                .catch();
        }

        newServer.imq = imq;

        this.imqs.push(imq);
        this.servers.push(newServer);
        this.clusterEmitter.emit('add', { server: newServer, imq });
        this.queueLength = this.imqs.length;
    }

    private eventEmitters(): EventEmitter[] {
        return [...this.imqs, this.templateEmitter];
    }

    private async initializeQueue(imq: RedisQueue): Promise<void> {
        copyEventEmitter(this.templateEmitter, imq);

        if (this.state.started) {
           await imq.start();
        }

        for (const subscription of this.state.subscriptions) {
            await imq.subscribe(subscription.channel, subscription.handler);
        }
    }

    private findServer(server: IServerInput): ClusterServer | undefined {
        return this.servers.find(
            existing => ClusteredRedisQueue.matchServers(
                existing,
                server,
            ),
        );
    }

    private static matchServers(
        source: IServerInput,
        target: IServerInput,
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
}
