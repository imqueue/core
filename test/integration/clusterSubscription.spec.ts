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
import {
    createConnection,
    createServer,
    type Server,
    type Socket,
} from 'node:net';
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

/**
 * Resolves once the broker reports a subscriber on `channel`, or rejects on
 * timeout. The live registration path announces nothing, so the broker is the
 * only witness that a refused member was subscribed after all.
 */
const subscribed = async (
    publisher: Redis,
    channel: string,
    timeoutMs: number,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const [, count] = (await publisher.pubsub('NUMSUB', channel)) as [
            string,
            number,
        ];

        if (+count > 0) {
            return;
        }

        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for a subscriber on ${channel}`);
        }

        await new Promise(resolve => setTimeout(resolve, 25));
    }
};

/** Bounds a test gate without leaving a timer behind on success or failure. */
const bounded = async <T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = 5000,
): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`timed out: ${label}`)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Takes an ephemeral port out of circulation, then releases it. Connecting to
 * the returned loopback port before another listener is started gets the real
 * TCP ECONNREFUSED that a broker which is not up yet would produce.
 */
const closedPort = async (): Promise<number> => {
    const reservation = createServer();

    await once(reservation.listen({ host: '127.0.0.1', port: 0 }), 'listening');

    const address = reservation.address();

    if (!address || typeof address === 'string') {
        throw new Error('could not reserve an IPv4 test port');
    }

    await new Promise<void>((resolve, reject) => {
        reservation.close(error => (error ? reject(error) : resolve()));
    });

    return address.port;
};

/**
 * A deliberately transparent TCP bridge. Redis protocol bytes are neither
 * parsed nor fabricated: after start(), the joining host talks to the broker
 * through normal TCP sockets.
 */
class RedisProxy {
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();

    public constructor(private readonly port: number) {}

    public async start(): Promise<void> {
        if (this.server) {
            return;
        }

        const server = createServer(client => {
            const upstream = createConnection({ host: HOST, port: PORT });
            const closeBoth = (): void => {
                client.destroy();
                upstream.destroy();
            };

            this.sockets.add(client);
            this.sockets.add(upstream);
            client.once('close', () => this.sockets.delete(client));
            upstream.once('close', () => this.sockets.delete(upstream));
            client.on('error', closeBoth);
            upstream.on('error', closeBoth);
            client.pipe(upstream).pipe(client);
        });

        // Keep a durable error listener after the listen() await has settled.
        server.on('error', quiet.error);
        await once(
            server.listen({ host: '127.0.0.1', port: this.port }),
            'listening',
        );
        this.server = server;
    }

    public async close(): Promise<void> {
        for (const socket of this.sockets) {
            socket.destroy();
        }

        this.sockets.clear();

        if (!this.server?.listening) {
            return;
        }

        const server = this.server;
        this.server = undefined;
        await new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    }
}

describe('ClusteredRedisQueue subscription over a real broker', () => {
    const queues: ClusteredRedisQueue[] = [];

    const cluster = (
        name: string,
        logger = quiet,
        servers: Array<{ host: string; port: number }> = [],
    ): ClusteredRedisQueue => {
        // starts EMPTY unless told otherwise: the server is added after
        // subscribe(), which is the path where handlers used to be lost
        const queue = new ClusteredRedisQueue(name, {
            cluster: servers,
            logger,
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

    it(
        'repairs a join whose first real subscription connection is refused',
        { skip },
        async () => {
            const channel = `refused-${uuid()}`;
            const port = await closedPort();
            const proxy = new RedisProxy(port);
            const received: unknown[] = [];
            const refused = Promise.withResolvers<void>();
            const logger = {
                ...quiet,
                error(...args: unknown[]) {
                    const error = args.at(-1) as
                        | (Error & { code?: string })
                        | undefined;

                    if (error?.code === 'ECONNREFUSED') {
                        refused.resolve();
                    }
                },
            };
            const queue = cluster(`refused-${uuid()}`, logger);
            let publisher: Redis | undefined;

            try {
                // Register on the cluster before it has a host, so the new
                // host's catch-up is the only attempt to install this handler.
                await queue.subscribe(channel, data => received.push(data));

                // This has no listener at this point. The logger gate observes
                // the actual error event emitted by ioredis before the proxy is
                // allowed to forward anything to Redis.
                (queue as any).addServer({ host: '127.0.0.1', port });
                await bounded(
                    refused.promise,
                    'the joining subscription to be refused',
                );

                const controller = new AbortController();
                const initialized = once(
                    (queue as any).clusterEmitter,
                    'initialized',
                    { signal: controller.signal },
                );

                try {
                    await proxy.start();
                    // First reconnect and catch-up are each scheduled after
                    // one second. If their order needs a second catch-up,
                    // exponential backoff makes that three seconds total;
                    // ten seconds leaves ample scheduler and broker slack.
                    await bounded(
                        initialized,
                        'the repaired host to initialize',
                        10000,
                    );
                } finally {
                    controller.abort();
                }

                publisher = new Redis({
                    host: HOST,
                    port: PORT,
                    lazyConnect: true,
                    retryStrategy: null,
                });
                publisher.on('error', quiet.error);
                await publisher.connect();
                assert.equal(
                    await publisher.publish(
                        `${(queue as any).options.prefix}:${channel}`,
                        JSON.stringify({ mark: channel }),
                    ),
                    1,
                    'the recovered Redis connection has one subscriber',
                );
                await settle(received, 1);
                assert.deepEqual(received, [{ mark: channel }]);
            } finally {
                // Stop producers first. Keep the bridge live while the queue
                // closes its subscription, then tear down both ends of every
                // bridged socket before closing the listening socket.
                publisher?.disconnect();
                await queue.destroy().catch(() => undefined);
                await proxy.close().catch(() => undefined);
            }
        },
    );

    it(
        'repairs a member whose first live subscription connection is refused',
        { skip },
        async () => {
            const channel = `member-${uuid()}`;
            const port = await closedPort();
            const proxy = new RedisProxy(port);
            const received: unknown[] = [];
            // a statically configured cluster: the host is a member before any
            // registration, so the live path is the only one that reaches it
            const queue = cluster(`member-${uuid()}`, quiet, [
                { host: '127.0.0.1', port },
            ]);
            let publisher: Redis | undefined;

            try {
                // nothing listens on the port yet, so this is the real refusal
                await assert.rejects(
                    queue.subscribe(channel, data => received.push(data)),
                );

                await proxy.start();

                publisher = new Redis({
                    host: HOST,
                    port: PORT,
                    lazyConnect: true,
                    retryStrategy: null,
                });
                publisher.on('error', quiet.error);
                await publisher.connect();

                const target = `${(queue as any).options.prefix}:${channel}`;

                // Reconnect and catch-up are each due after one second, and a
                // catch-up that loses that race is due again two seconds
                // later; ten seconds leaves ample scheduler and broker slack.
                await subscribed(publisher, target, 10000);

                assert.equal(
                    await publisher.publish(
                        target,
                        JSON.stringify({ mark: channel }),
                    ),
                    1,
                    'the recovered Redis connection has one subscriber',
                );
                await settle(received, 1);
                assert.deepEqual(received, [{ mark: channel }]);
            } finally {
                publisher?.disconnect();
                await queue.destroy().catch(() => undefined);
                await proxy.close().catch(() => undefined);
            }
        },
    );
});
