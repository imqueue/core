/*!
 * IMQ integration tests: what a removed server already delivered
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
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { ClusteredRedisQueue, RedisQueue } from '../../src/index.js';
import { startFreezingProxy } from './freezingProxy.js';

process.setMaxListeners(100);

const HOST = process.env.REDIS_HOST || '127.0.0.1';
const PORT = +(process.env.REDIS_PORT || 6379);

const quiet = { log() {}, info() {}, warn() {}, error() {} };

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

/** Holds the event loop, as a gateway busy building a schema does. */
const busy = (ms: number): void => {
    const until = Date.now() + ms;

    while (Date.now() < until) {
        // spinning on purpose: nothing else may run meanwhile
    }
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A clustered queue on the one broker, started and listening. */
const joined = async (name: string, got: unknown[], port = PORT) => {
    const queue = new ClusteredRedisQueue(name, {
        logger: quiet,
        prefix: `test-${uuid()}`,
        cluster: [{ host: HOST, port }],
    });

    queue.on('message', (message: unknown) => got.push(message));
    await queue.start();
    // the reader asks its id, then blocks: give it the moment it takes
    await wait(200);

    return queue;
};

describe('a server removed from a cluster', { skip }, () => {
    it('hands on a reply its reader already took before the broker went', async () => {
        const got: unknown[] = [];
        const name = `Removed${uuid()}`;
        const queue = await joined(name, got);
        const sender = new RedisQueue(`Sender${uuid()}`, {
            logger: quiet,
            prefix: (queue as any).options.prefix,
            host: HOST,
            port: PORT,
        });

        try {
            await sender.start();
            // answered once the broker has pushed it - and with a reader
            // blocked on the list, handed it straight to that reader
            await sender.send(name, { reply: 'already taken' });
            // the reply is in the reader's socket, unread, while the event
            // loop is held; the server is removed before it is read
            busy(100);
            (queue as any).removeServer({ host: HOST, port: PORT });

            const deadline = Date.now() + 3000;

            while (got.length === 0 && Date.now() < deadline) {
                await wait(25);
            }

            assert.deepEqual(
                got,
                [{ reply: 'already taken' }],
                'a reply the reader had taken was lost with the server',
            );
        } finally {
            await sender.destroy();
            await queue.destroy();
        }
    });

    it('is kept, and goes on delivering, where only its announcements lapsed', async () => {
        const got: unknown[] = [];
        const name = `Lapsed${uuid()}`;
        const queue = await joined(name, got);
        const sender = new RedisQueue(`Sender${uuid()}`, {
            logger: quiet,
            prefix: (queue as any).options.prefix,
            host: HOST,
            port: PORT,
        });

        try {
            await sender.start();
            (queue as any).removeServer(
                { host: HOST, port: PORT },
                { lapsed: true },
            );
            await wait(300);

            assert.equal(
                (queue as any).servers.length,
                1,
                'a broker that answers was dropped for a missed heartbeat',
            );

            await sender.send(name, { reply: 'after the lapse' });

            const deadline = Date.now() + 3000;

            while (got.length === 0 && Date.now() < deadline) {
                await wait(25);
            }

            assert.deepEqual(got, [{ reply: 'after the lapse' }]);
        } finally {
            await sender.destroy();
            await queue.destroy();
        }
    });

    it('is removed once it stops answering, after it was kept for a lapse', async () => {
        const proxy = await startFreezingProxy(HOST, PORT);
        const address = { host: '127.0.0.1', port: proxy.port };
        const queue = await joined(`KeptThenHung${uuid()}`, [], proxy.port);

        try {
            // as a UDP announcement hands it over: announced every second
            (queue as any).removeServer(
                { ...address, timeout: 1000 },
                { lapsed: true },
            );
            await wait(300);

            assert.equal(
                (queue as any).servers.length,
                1,
                'a broker that answers was dropped for a missed heartbeat',
            );

            // the broker hangs: its socket stays open and nothing answers.
            // No announcement will ever report it again
            proxy.freeze();

            const frozenAt = Date.now();
            // the next check is due within the announced second, and the
            // PING is given IMQ_LAPSED_ANSWER_TIMEOUT (2 s) to come back
            const deadline = frozenAt + 1000 + 2000 + 1500;

            while ((queue as any).servers.length > 0 && Date.now() < deadline) {
                await wait(50);
            }

            assert.equal(
                (queue as any).servers.length,
                0,
                'a kept broker that stopped answering stayed in routing ' +
                    `${Date.now() - frozenAt} ms after it hung`,
            );
            assert.equal((queue as any).imqs.length, 0);
        } finally {
            // the proxy first: a queue still holding a frozen connection
            // would otherwise wait on it for its whole teardown
            await proxy.close();
            await queue.destroy();
        }
    });

    it('takes nothing more once drained: what arrives after waits in redis', async () => {
        const got: unknown[] = [];
        const name = `Drained${uuid()}`;
        const queue = await joined(name, got);
        const raw = new Redis({ host: HOST, port: PORT });

        try {
            const prefix = (queue as any).options.prefix;
            const imq = (queue as any).imqs[0];

            await imq.drain(1000);
            await raw.lpush(`${prefix}:${name}`, JSON.stringify({ later: 1 }));
            await wait(200);

            assert.deepEqual(got, [], 'a drained reader took a message');
            assert.equal(
                await raw.llen(`${prefix}:${name}`),
                1,
                'the message left redis without reaching anybody',
            );
        } finally {
            raw.disconnect();
            await queue.destroy();
        }
    });
});
