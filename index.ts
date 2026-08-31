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
/**
 * Redis-backed message queue engine for the `@imqueue` framework — the
 * transport shared by `@imqueue/rpc` and the job packages.
 *
 * Start from `IMQ.create()`, which picks a queue adapter from the options and
 * returns an unstarted `IMessageQueue`. The two concrete adapters are
 * `RedisQueue` (a single Redis server) and `ClusteredRedisQueue` (several
 * servers, with sends distributed between them), and either can also be
 * constructed directly.
 *
 * @remarks
 * Every queue follows the same lifecycle: construct, `start()`, then either
 * consume `message` events or `send()`, and finally `destroy()` to release the
 * connections. `start()` is required before `publish()` or `subscribe()`;
 * `send()` starts the queue implicitly. `stop()` only stops consuming — it
 * keeps the writer, the watcher lock and the maintenance timers alive, so
 * `destroy()` is what actually releases resources.
 *
 * Delivery is at-least-once, so message handlers must be idempotent. Within a
 * single process, writer and watcher connections are shared per `host:port` and
 * TLS configuration and reference-counted, and exactly one queue per key prefix
 * is elected as the watcher that releases delayed messages and performs
 * maintenance.
 *
 * Under {@link IMQOptions.safeDelivery} a message stays checked out to its
 * worker until the `message` listener has finished with it, and what a listener
 * **returns** is how it says so: return a promise and the message is held until
 * that promise settles, so a worker that dies mid-handler leaves the message to
 * be re-queued rather than taking it down. Return anything else — as the
 * synchronous example below does — and it is released as the listener returns.
 *
 * @example
 * ```typescript
 * import IMQ, { IMQMode, type IMessageQueue } from '@imqueue/core';
 *
 * const queue: IMessageQueue = IMQ.create('my-queue', {
 *     host: 'localhost',
 *     port: 6379,
 * });
 *
 * queue.on('message', (message, id, from) => {
 *     console.log(`got ${id} from ${from}`, message);
 * });
 *
 * await queue.start();
 * await queue.send('my-queue', { hello: 'world' });
 * ```
 *
 * @packageDocumentation
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
 * Message queue factory. This is also the default export of `@imqueue/core`.
 *
 * @remarks
 * The factory only selects and instantiates an adapter — it performs no I/O, so
 * the queue it returns is not connected. Call `start()` on it (or `send()`,
 * which starts the queue implicitly) before use.
 */
export default class IMQ {
    /**
     * Base generic queue factory options.
     */
    private static options: Partial<IMQOptions> = {
        vendor: 'Redis', // default vendor
    };

    /**
     * Instantiates the queue adapter matching the given options and returns it
     * ready to be started.
     *
     * The adapter is chosen from `options.vendor`, of which only `'Redis'` is
     * supported. When either `options.cluster` or `options.clusterManagers` is
     * present, the clustered adapter is returned instead of the single-server
     * one.
     *
     * @param name - queue name; the underlying Redis key becomes
     *        `<prefix>:<name>`
     * @param options - queue options; anything omitted falls back to
     *        {@link DEFAULT_IMQ_OPTIONS}
     * @param mode - whether the queue produces, consumes, or both; defaults to
     *        {@link IMQMode.BOTH}
     * @returns an unstarted queue instance — a {@link ClusteredRedisQueue} when
     *          cluster options were supplied, otherwise a {@link RedisQueue}
     * @throws TypeError when `options.vendor` names an unknown adapter
     *
     * @remarks
     * `options.vendor` is honoured only here. Constructing a queue class
     * directly ignores it, because {@link DEFAULT_IMQ_OPTIONS} carries no
     * `vendor` key.
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
            throw new TypeError(
                `IMQ: unknown queue vendor requested: ${options.vendor}`,
            );
        }

        return new Adapter(name, options, mode);
    }
}
