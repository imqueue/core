/*!
 * Basic types and interfaces
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
import { IMQMode } from './IMQMode';

export { EventEmitter } from 'events';

/**
 * Represents any JSON-serializable value
 */
export type AnyJson =  boolean | number | string | null | undefined |
    JsonArray | JsonObject;

/**
 * Represents JSON serializable object
 */
export interface JsonObject {
    [key: string]: AnyJson;
}

/**
 * Represents JSON-serializable array
 */
export interface JsonArray extends Array<AnyJson> {}

/**
 * Alias for JsonObject, legacy, outdated, deprecated, try to avoid using.
 * Stands here for backward-compatibility only
 *
 * @deprecated
 */
export type IJson = JsonObject;

/**
 * Logger interface
 */
export interface ILogger {
    /**
     * Log level function
     *
     * @param {...any[]} args
     */
    log(...args: any[]): void;

    /**
     * Info level function
     *
     * @param {...any[]} args
     */
    info(...args: any[]): void;

    /**
     * Warning level function
     *
     * @param {...any[]} args
     */
    warn(...args: any[]): void;

    /**
     * Error level function
     *
     * @param {...any[]} args
     */
    error(...args: any[]): void;
}

/**
 * Defines message format.
 *
 * @type {IMessage}
 */
export interface IMessage {
    /**
     * Message unique identifier
     *
     * @type {string}
     */
    id: string;

    /**
     * Message data. Any JSON-compatible data allowed
     *
     * @type {JsonObject}
     */
    message: JsonObject;

    /**
     * Message source queue name
     *
     * @type {string}
     */
    from: string;

    /**
     * Message delay in milliseconds (for delayed messages). Optional.
     *
     * @type {number}
     */
    delay?: number;
}

/**
 * Message queue options
 */
export interface IMQOptions {
    /**
     * Turns on/off cleanup of the message queues
     *
     * @type {boolean}
     */
    cleanup: boolean;

    /**
     * Defines cleanup pattern for the name of the queue
     * which should be removed during cleanup processing
     *
     * @type {string}
     */
    cleanupFilter: string,

    /**
     * Message queue network host
     *
     * @type {string}
     */
    host?: string;

    /**
     * Message queue network port
     *
     * @type {number}
     */
    port?: number;

    /**
     * Message queue username host
     *
     * @type {string}
     */
    username?: string;

    /**
     * Message queue password port
     *
     * @type {string}
     */
    password?: string;

    /**
     * Message queue vendor
     *
     * @type {string}
     */
    vendor?: string;

    /**
     * Message queue global key prefix (namespace)
     *
     * @type {string}
     */
    prefix?: string;

    /**
     * Logger defined to be used within message queue in runtime
     *
     * @type {ILogger}
     */
    logger?: ILogger;

    /**
     * Watcher check delay period. This is used by a queue watcher
     * agent to make sure at least one watcher is available for
     * queue operations.
     *
     * @type {number}
     */
    watcherCheckDelay?: number;

    /**
     * A way to serialize message using compression. Will increase
     * load to worker process but can decrease network traffic between worker
     * and queue host application
     *
     * @type {boolean}
     */
    useGzip?: boolean;

    /**
     * Enables/disables safe message delivery. When safe message delivery
     * is turned on it will use more complex algorithm for message handling
     * by a worker process, guaranteeing that if worker fails the message will
     * be delivered to another possible worker anyway. In most cases it
     * is not required unless it is required by a system design.
     *
     * @type {boolean}
     */
    safeDelivery?: boolean;

    /**
     * Time-to-live of worker queues (after this time messages are back to
     * main queue for handling if worker died). Only works if safeDelivery
     * option enabled.
     *
     * @type {number}
     */
    safeDeliveryTtl?: number;

    /**
     * Queue cluster instances, if MQ should be clustered
     *
     * @type {{
     *  host: string;
     *  port: number;
     *  username: string;
     *  password: string;
     * }[]}
     */
    cluster?: {
        // tslint:disable-next-line:completed-docs
        host: string,
        // tslint:disable-next-line:completed-docs
        port: number,
        // tslint:disable-next-line:completed-docs
        username?: string;
        // tslint:disable-next-line:completed-docs
        password?: string;
    }[];
}

export type IMessageQueueConstructor = new (
    name: string,
    options?: Partial<IMQOptions>,
    mode?: IMQMode,
) => IMessageQueue;

/**
 * Generic messaging queue implementation interface
 *
 * @example
 * ~~~typescript
 * import { IMessageQueue, EventEmitter, uuid } from '@imqueue/core';
 *
 * class SomeMQAdapter implements IMessageQueue extends EventEmitter {
 *      public async start(): Promise<SomeMQAdapter> {
 *          // ... implementation goes here
 *          return this;
 *      }
 *      public async stop(): Promise<SomeMQAdapter> {
 *          // ... implementation goes here
 *          return this;
 *      }
 *      public async send(
 *          toQueue: string,
 *          message: JsonObject,
 *          delay?: number
 *      ): Promise<string> {
 *          const messageId = uuid();
 *          // ... implementation goes here
 *          return messageId;
 *      }
 *      public async destroy(): Promise<void> {
 *          // ... implementation goes here
 *      }
 *      public async clear(): Promise<SomeMQAdapter> {
 *          // ... implementation goes here
 *          return this;
 *      }
 * }
 * ~~~
 */
export interface IMessageQueue extends EventEmitter {
    /**
     * Message event. Occurs every time queue got a message.
     *
     * @event IMessageQueue#message
     * @type {JsonObject} message - message data
     * @type {string} id - message identifier
     * @type {string} from - source queue produced the message
     */

    /**
     * Error event. Occurs every time queue caught an error.
     *
     * @event IMessageQueue#error
     * @type {Error} err - error caught by message queue
     * @type {string} code - message queue error code
     */

    /**
     * Starts the messaging queue.
     * Supposed to be an async function.
     *
     * @returns {Promise<IMessageQueue>}
     */
    start(): Promise<IMessageQueue>;

    /**
     * Stops the queue (should stop handle queue messages).
     * Supposed to be an async function.
     *
     * @returns {Promise<IMessageQueue>}
     */
    stop(): Promise<IMessageQueue>;

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
    send(toQueue: string, message: JsonObject, delay?: number,
         errorHandler?: (err: Error) => void): Promise<string>;

    /**
     * Creates or uses subscription channel with the given name and sets
     * message handler on data receive
     *
     * @param {string} channel - channel name
     * @param {(data: JsonObject) => any} handler
     */
    subscribe(
        channel: string,
        handler: (data: JsonObject) => any,
    ): Promise<void>;

    /**
     * Closes subscription channel
     *
     * @return {Promise<void>}
     */
    unsubscribe(): Promise<void>;

    /**
     * Publishes data to current queue channel
     *
     * If toName specified will publish to pubsub with different name. This
     * can be used to implement broadcasting some messages to other subscribers
     * on other pubsub channels. Different name should be in the same namespace
     * (same imq prefix)
     *
     * @param {JsonObject} data - data to publish as channel message
     * @param {string} [toName] - different name of the pubsub to publish to
     * @return {Promise<void>}
     */
    publish(data: JsonObject, toName?: string): Promise<void>;

    /**
     * Safely destroys current queue, unregistered all set event
     * listeners and connections.
     * Supposed to be an async function.
     *
     * @returns {Promise<void>}
     */
    destroy(): Promise<void>;

    /**
     * Clears queue data in queue host application.
     * Supposed to be an async function.
     *
     * @returns {Promise<IMessageQueue>}
     */
    clear(): Promise<IMessageQueue>;
}
