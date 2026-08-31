/*!
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
import '../mocks/index.js';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import {
    ClusteredRedisQueue,
    RedisQueue,
    type IMQOptions,
} from '../../src/index.js';
import { makeLogger } from '../helpers/index.js';

process.setMaxListeners(100);

const CA = Buffer.from('-----BEGIN CERTIFICATE-----\nCA\n');
const OTHER_CA = Buffer.from('-----BEGIN CERTIFICATE-----\nOTHER\n');

const VARS = [
    'IMQ_REDIS_TLS',
    'IMQ_REDIS_TLS_CA_FILE',
    'IMQ_REDIS_TLS_SERVERNAME',
    'IMQ_REDIS_TLS_REJECT_UNAUTHORIZED',
];

/** The options the redis client was actually constructed with */
const clientOptions = (rq: any, channel: string): any =>
    rq.connectionOf(channel)?.options;

/**
 * A started queue on a host of its own, so that the process-wide writer and
 * watcher pools of one test cannot be reached by another.
 */
const queue = async (
    t: any,
    options: Partial<IMQOptions> = {},
): Promise<any> => {
    const rq: any = new RedisQueue(uuid(), {
        host: `tls-test-${uuid()}`,
        logger: makeLogger(),
        ...options,
    });

    t.after(() => rq.destroy().catch(() => undefined));

    await rq.start();

    return rq;
};

describe('RedisQueue TLS', () => {
    afterEach(() => {
        for (const name of VARS) {
            delete process.env[name];
        }
    });

    describe('option pass-through', () => {
        it('should reach every channel the queue opens', async t => {
            const rq = await queue(t, { tls: { ca: CA } });

            await rq.subscribe(() => undefined);

            for (const channel of [
                'reader',
                'writer',
                'watcher',
                'subscription',
            ]) {
                assert.deepEqual(
                    clientOptions(rq, channel)?.tls,
                    { ca: CA },
                    `${channel} channel`,
                );
            }
        });

        it('should normalise `true` into an empty option object', async t => {
            // ioredis only tests the option for truthiness, but an object keeps
            // the shape uniform for anything reading it back
            const rq = await queue(t, { tls: true });

            assert.deepEqual(clientOptions(rq, 'writer').tls, {});
        });

        it('should omit the option entirely when TLS is off', async t => {
            const rq = await queue(t);

            assert.ok(!('tls' in clientOptions(rq, 'writer')));
        });

        it('should omit the option when TLS is declined explicitly', async t => {
            const rq = await queue(t, { tls: false });

            assert.ok(!('tls' in clientOptions(rq, 'writer')));
        });

        it('should leave the connection settings it owns alone', async t => {
            // the literal stays closed: TLS must not become a way in for
            // options the reconnection logic depends on
            const rq = await queue(t, {
                tls: { ca: CA, lazyConnect: false } as any,
            });
            const options = clientOptions(rq, 'writer');

            assert.equal(options.lazyConnect, true);
            assert.equal(options.maxRetriesPerRequest, null);
            assert.equal(options.tls.lazyConnect, false);
        });
    });

    describe('connection pooling', () => {
        it('should keep an encrypted connection out of a plaintext slot', async t => {
            // the point of the whole exercise: a queue asking for TLS must
            // never be handed the plaintext socket another queue opened first
            const host = `tls-pool-${uuid()}`;
            const plain = await queue(t, { host });
            const secure = await queue(t, { host, tls: { ca: CA } });

            assert.equal(plain.redisKey, secure.redisKey);
            assert.notEqual(plain.poolKey, secure.poolKey);
            assert.notEqual(plain.writer, secure.writer);
            assert.notEqual(plain.watcher, secure.watcher);
            assert.ok(!('tls' in plain.writer.options));
            assert.deepEqual(secure.writer.options.tls, { ca: CA });
        });

        it('should separate connections with different trust anchors', async t => {
            const host = `tls-pool-${uuid()}`;
            const one = await queue(t, { host, tls: { ca: CA } });
            const two = await queue(t, { host, tls: { ca: OTHER_CA } });

            assert.notEqual(one.poolKey, two.poolKey);
            assert.notEqual(one.writer, two.writer);
        });

        it('should still share between equal configurations', async t => {
            const host = `tls-pool-${uuid()}`;
            const one = await queue(t, { host, tls: { ca: CA } });
            const two = await queue(t, {
                host,
                tls: { ca: Buffer.from(CA) },
            });

            assert.equal(one.poolKey, two.poolKey);
            assert.equal(one.writer, two.writer);
            assert.equal(one.watcher, two.watcher);
        });

        it('should keep reporting the plain address as the redis key', async t => {
            // `redisKey` is public and names the server in logs; it must not
            // grow a fingerprint just because the pool key did
            const rq = await queue(t, {
                host: 'tls-key-host',
                port: 6380,
                tls: true,
            });

            assert.equal(rq.redisKey, 'tls-key-host:6380');
            assert.ok(rq.poolKey.startsWith('tls-key-host:6380#'));
        });

        it('should release a shared encrypted writer only once unused', async t => {
            const host = `tls-pool-${uuid()}`;
            const one = await queue(t, { host, tls: { ca: CA } });
            const two = await queue(t, { host, tls: { ca: CA } });
            const writer = one.writer;

            await one.destroy();

            assert.equal(two.writer, writer);

            await two.destroy();

            assert.equal(two.writer, undefined);
        });
    });

    describe('environment fallback', () => {
        it('should pick TLS up from the environment', async t => {
            process.env.IMQ_REDIS_TLS = '1';

            const rq = await queue(t);

            assert.deepEqual(rq.options.tls, {});
            assert.deepEqual(clientOptions(rq, 'writer').tls, {});
        });

        it('should let explicit options decline the environment', async t => {
            process.env.IMQ_REDIS_TLS = '1';

            const rq = await queue(t, { tls: false });

            assert.equal(rq.options.tls, false);
            assert.ok(!('tls' in clientOptions(rq, 'writer')));
        });

        it('should let explicit options override the environment', async t => {
            process.env.IMQ_REDIS_TLS = '1';

            const rq = await queue(t, { tls: { ca: CA } });

            assert.deepEqual(clientOptions(rq, 'writer').tls, { ca: CA });
        });

        it('should throw rather than connect in the clear', () => {
            // an unmounted secret is a deployment failure, and failing to
            // construct is the only outcome that cannot end in plaintext
            process.env.IMQ_REDIS_TLS_CA_FILE = '/nonexistent/imq/ca.crt';

            assert.throws(
                () => new RedisQueue(uuid(), { logger: makeLogger() }),
                /IMQ_REDIS_TLS_CA_FILE/,
            );
        });
    });

    describe('warnings', () => {
        it('should warn when certificate verification is disabled', async t => {
            const warnings: string[] = [];
            const logger = makeLogger();

            logger.warn = (...args: unknown[]) => warnings.push(args.join(' '));

            await queue(t, {
                logger,
                tls: { ca: CA, rejectUnauthorized: false },
            });

            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /verification is disabled/);
        });

        it('should stay quiet when verification is left on', async t => {
            const warnings: string[] = [];
            const logger = makeLogger();

            logger.warn = (...args: unknown[]) => warnings.push(args.join(' '));

            await queue(t, { logger, tls: { ca: CA } });

            assert.equal(warnings.length, 0);
        });
    });

    describe('a queue that never asked for TLS', () => {
        // the guarantee for everyone who does not use this feature: nothing
        // they can observe about a queue changes because the option exists
        it('should carry no `tls` key on its options at all', async t => {
            const rq = await queue(t);

            assert.equal('tls' in rq.options, false);
        });

        it('should pool exactly as it did, on the plain address', async t => {
            const host = `tls-compat-${uuid()}`;
            const one = await queue(t, { host });
            const two = await queue(t, { host });

            assert.equal(one.poolKey, one.redisKey);
            assert.equal(one.poolKey, two.poolKey);
            assert.equal(one.writer, two.writer);
            assert.equal(one.watcher, two.watcher);
        });

        it('should hand the client no TLS option on any channel', async t => {
            const rq = await queue(t);

            await rq.subscribe(() => undefined);

            for (const channel of [
                'reader',
                'writer',
                'watcher',
                'subscription',
            ]) {
                assert.equal(
                    'tls' in clientOptions(rq, channel),
                    false,
                    `${channel} channel`,
                );
            }
        });

        it('should be unaffected by unrelated IMQ_ variables', async t => {
            // the environment lookup runs for every queue now, so a variable
            // that merely looks adjacent must not switch the transport on
            process.env.IMQ_REDIS_TLS_REJECT_UNAUTHORIZED = '0';
            process.env.IMQ_REDIS_TLS_SERVERNAME = 'redis.internal';

            const rq = await queue(t);

            assert.equal('tls' in rq.options, false);
            assert.equal('tls' in clientOptions(rq, 'writer'), false);
        });

        it('should not warn about anything', async t => {
            const warnings: string[] = [];
            const logger = makeLogger();

            logger.warn = (...args: unknown[]) => warnings.push(args.join(' '));

            await queue(t, { logger });

            assert.deepEqual(warnings, []);
        });
    });

    describe('teardown', () => {
        it('should not rethrow a socket error arriving after the failure', async t => {
            // the client guards its socket with a one-shot listener that the
            // first failure spends; a rejected TLS handshake is answered by an
            // alert that lands after it, and an unguarded socket would take
            // the process down with it
            const rq: any = await queue(t, { tls: { ca: CA } });
            const socket = rq.writer.stream;

            rq.writer.emit('error', new Error('handshake rejected'));

            assert.doesNotThrow(() =>
                socket.emit('error', new Error('alert 50')),
            );
        });

        it('should guard a socket only once', async t => {
            const rq: any = await queue(t, { tls: { ca: CA } });
            const socket = rq.writer.stream;

            for (let i = 0; i < 5; i++) {
                rq.writer.emit('error', new Error('flapping'));
            }

            assert.equal(socket.listenerCount('error'), 1);
        });

        it('should not rethrow a connection error raised while closing', async t => {
            // a failed TLS handshake leaves a socket that errors on the write
            // `quit()` performs; with the listeners already gone that error
            // would reach an EventEmitter with nothing attached and take the
            // process down mid-shutdown
            const rq: any = await queue(t, { tls: { ca: CA } });
            const writer = rq.writer;

            await rq.destroy();

            assert.doesNotThrow(() =>
                writer.emit('error', new Error('socket is gone')),
            );
        });
    });

    describe('across a cluster', () => {
        it('should carry cluster-wide TLS to every server', async t => {
            const cluster = new ClusteredRedisQueue(uuid(), {
                logger: makeLogger(),
                tls: { ca: CA },
                cluster: [
                    { host: `tls-cl-${uuid()}`, port: 6379 },
                    { host: `tls-cl-${uuid()}`, port: 6379 },
                ],
            } as Partial<IMQOptions>);

            t.after(() => cluster.destroy().catch(() => undefined));

            for (const imq of (cluster as any).imqs) {
                assert.deepEqual(imq.options.tls, { ca: CA });
            }
        });

        it('should still ignore per-entry credentials', async t => {
            // unchanged on purpose: entries have never carried credentials
            // through, and making them do so would alter what an existing
            // cluster connects with - which has nothing to do with TLS
            const own = `tls-cl-creds-${uuid()}`;
            const cluster = new ClusteredRedisQueue(uuid(), {
                logger: makeLogger(),
                username: 'shared',
                password: 'shared-secret',
                cluster: [
                    {
                        host: own,
                        port: 6379,
                        username: 'own',
                        password: 'own-secret',
                    },
                ],
            } as Partial<IMQOptions>);

            t.after(() => cluster.destroy().catch(() => undefined));

            const [imq] = (cluster as any).imqs;

            assert.equal(imq.options.username, 'shared');
            assert.equal(imq.options.password, 'shared-secret');
        });

        it('should let one server override the cluster-wide settings', async t => {
            const own = `tls-cl-own-${uuid()}`;
            const cluster = new ClusteredRedisQueue(uuid(), {
                logger: makeLogger(),
                username: 'shared',
                password: 'shared-secret',
                tls: { ca: CA },
                cluster: [
                    { host: `tls-cl-${uuid()}`, port: 6379 },
                    { host: own, port: 6379, tls: { ca: OTHER_CA } },
                ],
            } as Partial<IMQOptions>);

            t.after(() => cluster.destroy().catch(() => undefined));

            const queues: any[] = (cluster as any).imqs;
            const overridden = queues.find(imq => imq.options.host === own);
            const inherited = queues.find(imq => imq.options.host !== own);

            assert.deepEqual(overridden.options.tls, { ca: OTHER_CA });
            assert.deepEqual(inherited.options.tls, { ca: CA });

            // credentials still come from the top level for both
            assert.equal(overridden.options.username, 'shared');
            assert.equal(inherited.options.username, 'shared');
        });
    });
});
