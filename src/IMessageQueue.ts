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
export type AnyJson =
    | boolean
    | number
    | string
    | null
    | undefined
    | JsonArray
    | JsonObject;

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
 * Logger interface
 */
export interface ILogger {
    /**
     * Log level function
     *
     * @param {...unknown[]} args
     */
    log(...args: unknown[]): void;

    /**
     * Info level function
     *
     * @param {...unknown[]} args
     */
    info(...args: unknown[]): void;

    /**
     * Warning level function
     *
     * @param {...unknown[]} args
     */
    warn(...args: unknown[]): void;

    /**
     * Error level function
     *
     * @param {...unknown[]} args
     */
    error(...args: unknown[]): void;
}

/**
 * Defines a message format.
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
     * Cleanup pattern for queue names that should be removed during cleanup
     *
     * @type {string}
     */
    cleanupFilter: string;

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
     * Logger instance to use for message queue logging at runtime
     *
     * @type {ILogger}
     */
    logger?: ILogger;

    /**
     * Delay period (in milliseconds) between watcher availability checks.
     * Used to ensure at least one watcher is available for queue operations.
     *
     * @type {number}
     */
    watcherCheckDelay?: number;

    /**
     * Enable message compression for serialization. Increases a worker CPU load
     * but decreases network traffic between workers and the queue host.
     *
     * @type {boolean}
     */
    useGzip?: boolean;

    /**
     * Enable guaranteed message delivery. When enabled, uses a more complex
     * algorithm for message handling, ensuring that if a worker fails, the
     * message will be delivered to another worker. Required only for systems
     * that demand guaranteed delivery semantics.
     *
     * @type {boolean}
     */
    safeDelivery?: boolean;

    /**
     * Time-to-live (in milliseconds) for messages in worker queues. After this
     * period, unacknowledged messages return to the main queue for reprocessing
     * if the worker died. Only effective when safeDelivery is enabled.
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
     * Enable process signal handling (SIGTERM, SIGINT, SIGABRT) by the queue.
     * When enabled, the queue releases its watcher lock and exits gracefully
     * on these signals. Disable if the host application manages shutdown.
     *
     * @default true
     * @type {boolean}
     */
    handleSignals?: boolean;

    /**
     * Enables/disables verbose logging
     *
     * @default false
     * @type {boolean}
     */
    verbose?: boolean;

    /**
     * Enables/disables extended verbose logging. The output may contain
     * sensitive information, so use it with caution. Does not work if a verbose
     * option is disabled.
     *
     * @default false
     * @type {boolean}
     */
    verboseExtended?: boolean;
}

export interface EventMap {
    message: [data: JsonObject, id: string, from: string];
    error: [error: Error, eventName: string];
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
 * import { IMessageQueue, EventEmitter } from '@imqueue/core';
 * import { randomUUID } from 'crypto';
 *
 * class SomeMQAdapter implements IMessageQueue extends EventEmitter {
 public async start(): Promise<SomeMQAdapter> {
 // ... implementation goes here
 return this;
 }
 public async stop(): Promise<SomeMQAdapter> {
 // ... implementation goes here
 return this;
 }
 public async send(
 toQueue: string,
 message: JsonObject,
 delay?: number
 ): Promise<string> {
 const messageId = randomUUID();
 // ... implementation goes here
 return messageId;
 }
 public async destroy(): Promise<void> {
 // ... implementation goes here
 }
 public async clear(): Promise<SomeMQAdapter> {
 // ... implementation goes here
 return this;
 }
 * }
 * ~~~
 */
export interface IMessageQueue extends EventEmitter<EventMap> {
    /**
     * Message event. Occurs every time the queue receives a message.
     *
     * @event IMessageQueue#message
     * @type {JsonObject} message - message data
     * @type {string} id - message identifier
     * @type {string} from - source queue that produced the message
     */

    /**
     * Error event. Occurs every time the queue encounters an error.
     *
     * @event IMessageQueue#error
     * @type {Error} err - error caught by the message queue
     * @type {string} code - message queue error code
     */

    /**
     * Starts the messaging queue.
     *
     * @returns {Promise<IMessageQueue>}
     */
    start(): Promise<IMessageQueue>;

    /**
     * Stops the queue from handling messages.
     *
     * @returns {Promise<IMessageQueue>}
     */
    stop(): Promise<IMessageQueue>;

    /**
     * Sends a message to the specified queue with the given data.
     *
     * @param {string} toQueue - name of the destination queue
     * @param {JsonObject} message - message data to send
     * @param {number} [delay] - if specified, the message will be handled in
     * the target queue after the specified delay in milliseconds
     * @param {(err: Error) => void} [errorHandler] - callback invoked only
     * when an internal error occurs during message send execution
     * @returns {Promise<string>} - the message identifier
     */
    send(
        toQueue: string,
        message: JsonObject,
        delay?: number,
        errorHandler?: (err: Error) => void,
    ): Promise<string>;

    /**
     * Creates or uses a subscription channel with the given name and sets
     * message handler on data receive
     *
     * @param {string} channel - channel name
     * @param {(data: JsonObject) => void} handler
     */
    subscribe(
        channel: string,
        handler: (data: JsonObject) => void,
    ): Promise<void>;

    /**
     * Closes the subscription channel
     *
     * @returns {Promise<void>}
     */
    unsubscribe(): Promise<void>;

    /**
     * Publishes data to the current queue channel
     *
     * If toName is specified, publishes to a pubsub with a different name. This
     * can be used to broadcast messages to other subscribers on different pubsub
     * channels. Different names must be in the same namespace (same imq prefix).
     *
     * @param {JsonObject} data - data to publish as a channel message
     * @param {string} [toName] - optional different pubsub name to publish to
     * @returns {Promise<void>}
     */
    publish(data: JsonObject, toName?: string): Promise<void>;

    /**
     * Safely destroys the current queue, unregistering all event listeners
     * and closing connections.
     *
     * @returns {Promise<void>}
     */
    destroy(): Promise<void>;

    /**
     * Clears all queue data from the queue host application.
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
