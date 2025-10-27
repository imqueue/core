/*!
 * Basic types and interfaces
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
import { EventEmitter } from 'events';
import { IMQMode } from './IMQMode';
import { ClusterManager } from './ClusterManager';

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

export interface IServerInput {
    /**
     * Message queue network unique identifier, optional property
     *
     * @type {string | undefined}
     */
    id?: string;

    /**
     * Message queue network host
     *
     * @type {string}
     */
    host: string;

    /**
     * Message queue network port
     *
     * @type {number}
     */
    port: number;
}

export interface IMessageQueueConnection extends IMessageQueueAuthConnection {
    /**
     * Message queue network unique identifier, optional property
     *
     * @type {string | undefined}
     */
    id?: string;

    /**
     * Message queue network host
     *
     * @type {string}
     */
    host: string;

    /**
     * Message queue network port
     *
     * @type {number}
     */
    port: number;
}

export interface IMessageQueueAuthConnection {
    /**
     * Message queue username
     *
     * @type {string}
     */
    username?: string;

    /**
     * Message queue password
     *
     * @type {string}
     */
    password?: string;
}

/**
 * Message queue options
 */
export interface IMQOptions extends Partial<IMessageQueueConnection> {
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
     * @type {IMessageQueueConnection[]}
     */
    cluster?: IMessageQueueConnection[];

    /**
     * Array of cluster managers used to handle cluster operations.
     * Any manager implements specific cluster server detection.
     *
     * @type {ClusterManager[]}
     */
    clusterManagers?: ClusterManager[];

    /**
     * Enables/disables verbose logging, default is false
     *
     * @type {boolean}
     */
    verbose?: boolean;
}

export interface EventMap {
    message: [data: any, id: string, from: string],
    error: [error: Error, eventName: string],
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
export interface IMessageQueue extends EventEmitter<EventMap> {
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

    /**
     * Retrieves the current count of messages in the queue.
     * Supposed to be an async function.
     *
     * @returns {Promise<number>}
     */
    queueLength(): Promise<number>;
}
