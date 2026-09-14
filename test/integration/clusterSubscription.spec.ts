/*!
 * ClusteredRedisQueue subscription integration specs
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
 *
 * @remarks
 * The unit specs replace `ioredis` wholesale, so they can prove which calls a
 * cluster makes and can exercise delivery through simulated events. These
 * specs additionally check actual Redis acknowledgments and message delivery
 * when a server joins after multiple subscribe() calls.
 *
 * These specs skip - never fail - where no redis is reachable, matching the
 * contract the TLS specs follow, so a checkout without redis stays green.
 */
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { once } from 'node:events';
import { after, describe, it, mock } from 'node:test';
import { Redis } from 'ioredis';
import { ClusteredRedisQueue, RedisQueue } from '../../src/index.js';

process.setMaxListeners(100);

const HOST = process.env.REDIS_HOST || '127.0.0.1';
const PORT = +(process.env.REDIS_PORT || 6379);

/** Silences the queue; a failing assertion says more than its log would */
const quiet = { log() {}, info() {}, warn() {}, error() {} };

/**
 * Confirms a broker answers, returning a skip reason instead of throwing when
 * it does not — a machine without redis must report these as skipped. Both
 * connection and PING are bounded, and reconnects cannot keep the probe alive.
 */
const brokerReason = async (): Promise<string | undefined> => {
    const probe = new Redis({
        host: HOST,
        port: PORT,
        lazyConnect: true,
        connectTimeout: 1000,
        commandTimeout: 1000,
        retryStrategy: null,
    });

    let connectionError: unknown;
    probe.on('error', error => {
        connectionError = error;
    });

    try {
        await probe.connect();
        await probe.ping();

        return undefined;
    } catch (err) {
        return `redis at ${HOST}:${PORT} is not reachable: ${String(connectionError || err)}`;
    } finally {
        probe.disconnect();
    }
};

const skip = await brokerReason();

/**
 * Adds the broker and waits for catch-up to finish, including subscription
 * acknowledgments. Listen before adding it so initialization cannot be missed.
 */
const join = async (queue: ClusteredRedisQueue): Promise<void> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const ready = once((queue as any).clusterEmitter, 'initialized', {
        signal: controller.signal,
    });

    try {
        (queue as any).addServer({ host: HOST, port: PORT });
        await ready;
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
};

/** Resolves once `received` holds `count` items, or rejects on timeout */
const settle = async (received: unknown[], count: number): Promise<void> => {
    const deadline = Date.now() + 5000;

    while (received.length < count) {
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for ${count} deliveries, got ` +
                    `${received.length}`,
            );
        }

        await new Promise(resolve => setTimeout(resolve, 25));
    }

    // a duplicate would arrive on the same tick as the last expected one
    await new Promise(resolve => setTimeout(resolve, 150));
};

/** Bounds a test gate without leaving a timer behind on success or failure. */
const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`timed out: ${label}`)),
                    5000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

describe('ClusteredRedisQueue subscription over a real broker', () => {
    const queues: ClusteredRedisQueue[] = [];

    const cluster = (name: string): ClusteredRedisQueue => {
        // starts EMPTY: the server is added after subscribe(), which is the
        // path where handlers used to be lost
        const queue = new ClusteredRedisQueue(name, {
            cluster: [],
            logger: quiet,
        });

        queues.push(queue);

        return queue;
    };

    after(async () => {
        for (const queue of queues) {
            await queue.destroy().catch(() => undefined);
        }
    });

    it(
        'preserves one subscription without starting the queue',
        { skip },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`single-${uuid()}`);
            const received: unknown[] = [];
            await join(queue);
            await queue.subscribe(channel, data => {
                received.push(data);
            });
            const publisher = new Redis({
                host: HOST,
                port: PORT,
                retryStrategy: null,
            });
            publisher.on('error', quiet.error);
            try {
                assert.equal(
                    await publisher.publish(
                        `${(queue as any).options.prefix}:${channel}`,
                        JSON.stringify({ mark: channel }),
                    ),
                    1,
                );
                await settle(received, 1);
                assert.deepEqual(received, [{ mark: channel }]);
            } finally {
                publisher.disconnect();
            }
        },
    );

    it(
        'delivers to every handler on a server that joined after subscribe()',
        {
            skip,
        },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`join-${uuid()}`);
            const first: unknown[] = [];
            const second: unknown[] = [];

            await queue.start();
            await queue.subscribe(channel, data => first.push(data));
            await queue.subscribe(channel, data => second.push(data));

            // the server arrives only now, so both handlers reach it through the
            // catch-up run rather than through the subscribe() calls themselves
            await join(queue);
            await queue.publish({ mark: channel }, channel);

            await settle(first, 1);
            await settle(second, 1);

            assert.deepEqual(first, [{ mark: channel }], 'first handler');
            assert.deepEqual(second, [{ mark: channel }], 'second handler');
        },
    );

    it(
        'delivers exactly once per handler, with no duplicates',
        {
            skip,
        },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`once-${uuid()}`);
            const received: unknown[] = [];

            await queue.start();
            await queue.subscribe(channel, data => received.push(data));

            await join(queue);
            await queue.publish({ mark: channel }, channel);

            await settle(received, 1);

            // This registration reaches the host only through catch-up; a
            // duplicate installation by that run would deliver twice.
            assert.equal(
                received.length,
                1,
                'exactly one delivery per handler',
            );
        },
    );

    it(
        'delivers exactly once when subscribe lands during host catch-up',
        { skip },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`overlap-${uuid()}`);
            const early: unknown[] = [];
            const live: unknown[] = [];
            const entered = Promise.withResolvers<void>();
            const gate = Promise.withResolvers<void>();

            await queue.start();
            await queue.subscribe(channel, data => {
                early.push(data);
            });

            const controller = new AbortController();
            const ready = once((queue as any).clusterEmitter, 'initialized', {
                signal: controller.signal,
            });
            // Observe rejection even when the first-registration gate fails first.
            void ready.catch(() => undefined);
            const original = RedisQueue.prototype.subscribe;
            let first = true;
            // Intercept BEFORE discovery, including a mutant that starts eagerly.
            const subscription = mock.method(
                RedisQueue.prototype,
                'subscribe',
                async function (
                    this: RedisQueue,
                    name: string,
                    handler: (data: any) => void,
                ) {
                    if (first) {
                        first = false;
                        entered.resolve();
                        await bounded(
                            gate.promise,
                            'first registration release',
                        );
                    }
                    await original.call(this, name, handler);
                },
            );

            try {
                (queue as any).addServer({ host: HOST, port: PORT });
                await bounded(
                    entered.promise,
                    'first registration interception',
                );
                const registering = queue.subscribe(channel, data => {
                    live.push(data);
                });
                // Preserve deferral: an unserialised run must get a turn while
                // the first registration is still held before ACK/installation.
                await new Promise<void>(resolve => setImmediate(resolve));
                gate.resolve();
                await bounded(
                    Promise.all([ready, registering]),
                    'host initialization',
                );
                await queue.publish({ mark: channel }, channel);
                await settle(early, 1);
                await settle(live, 1);
                assert.deepEqual(
                    early,
                    [{ mark: channel }],
                    'catch-up handler',
                );
                assert.deepEqual(live, [{ mark: channel }], 'live handler');
            } finally {
                gate.resolve();
                controller.abort();
                subscription.mock.restore();
            }
        },
    );

    it(
        'keeps two deliberate registrations of the same function',
        {
            skip,
        },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`twice-${uuid()}`);
            const received: unknown[] = [];
            const handler = (data: unknown): void => {
                received.push(data);
            };

            await queue.start();
            await queue.subscribe(channel, handler);
            await queue.subscribe(channel, handler);

            await join(queue);
            await queue.publish({ mark: channel }, channel);

            await settle(received, 2);

            // the interface documents repeated registration as additive
            assert.equal(received.length, 2, 'both registrations must fire');
        },
    );

    it(
        'delivers to a handler registered after the server joined',
        {
            skip,
        },
        async () => {
            const channel = `chan-${uuid()}`;
            const queue = cluster(`late-${uuid()}`);
            const early: unknown[] = [];
            const late: unknown[] = [];

            await queue.start();
            await queue.subscribe(channel, data => early.push(data));

            await join(queue);

            // registered once the host is already up to date, so this one goes
            // through the live path while the first went through the catch-up run
            await queue.subscribe(channel, data => late.push(data));
            await queue.publish({ mark: channel }, channel);

            await settle(early, 1);
            await settle(late, 1);

            assert.equal(early.length, 1, 'handler from the catch-up run');
            assert.equal(late.length, 1, 'handler from the live path');
        },
    );
});
