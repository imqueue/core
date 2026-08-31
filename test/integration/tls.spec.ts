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
/**
 * TLS against a real broker.
 *
 * The unit specs replace `ioredis` wholesale and never open a socket, which is
 * fine for every option except this one: what `tls` is for happens during a
 * handshake a mock does not perform. These specs therefore run unmocked, and
 * skip themselves - rather than fail - wherever `redis-server` and `openssl`
 * are not both available.
 */
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { connect } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { RedisQueue, type IMQOptions } from '../../src/index.js';
import { startTlsBroker, type TlsBroker } from './tlsBroker.js';

process.setMaxListeners(100);

const started = await startTlsBroker(false);
const startedMutual =
    typeof started === 'string' ? started : await startTlsBroker(true);

const skip = typeof started === 'string' ? started : undefined;
const skipMutual =
    typeof startedMutual === 'string' ? startedMutual : undefined;

const broker = started as TlsBroker;
const mutualBroker = startedMutual as TlsBroker;

/** Silences the queue; a failing assertion says more than its log would */
const quiet = { log() {}, info() {}, warn() {}, error() {} };

/**
 * A loopback address other than the one every other spec dials, or `undefined`
 * where the platform has only one. Linux gives the whole of 127.0.0.0/8;
 * macOS gives 127.0.0.1 alone unless an alias was added by hand.
 */
const otherAddress = async (port: number): Promise<string | undefined> =>
    new Promise(resolve => {
        const probe = connect({ host: '127.0.0.2', port }, () => {
            probe.destroy();
            resolve('127.0.0.2');
        });

        probe.setTimeout(1000, () => {
            probe.destroy();
            resolve(undefined);
        });
        probe.once('error', () => resolve(undefined));
    });

/** Lets an in-flight TLS alert land before the test closes */
const settle = (ms = 250): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

/** The TLS socket underneath a started queue's writer connection */
const socketOf = (rq: any): TLSSocket => rq.writer.stream as TLSSocket;

/**
 * An unstarted queue against the given broker, destroyed when the test ends.
 *
 * Each test gets a prefix of its own unless it states one, so that the watcher
 * election of one test cannot reach into another sharing the broker.
 */
const build = (
    t: any,
    port: number,
    options: Partial<IMQOptions> = {},
): any => {
    const rq: any = new RedisQueue(`ITls-${uuid()}`, {
        host: '127.0.0.1',
        port,
        logger: quiet,
        handleSignals: false,
        prefix: `itls-${uuid()}`,
        ...options,
    });

    t.after(() => rq.destroy().catch(() => undefined));

    return rq;
};

/** The same, started and ready to use */
const queue = async (
    t: any,
    port: number,
    options: Partial<IMQOptions> = {},
): Promise<any> => {
    const rq = build(t, port, options);

    await rq.start();

    return rq;
};

/**
 * Asserts that a queue configured this way cannot reach the broker.
 *
 * The whole lifecycle is driven inside the test rather than left to a teardown
 * hook: a refused handshake is answered by the server with an alert that
 * arrives asynchronously, and anything still in flight when the test ends is
 * reported by the runner as stray activity. Destroying the queue stops its
 * reconnection loop, and the settle window lets the last alert land while
 * there is still a listener for it.
 *
 * @param port - broker to dial
 * @param tls - the transport configuration under test, if any
 */
const refuses = async (
    port: number,
    tls?: Partial<IMQOptions>['tls'],
): Promise<void> => {
    const rq: any = new RedisQueue(`ITls-${uuid()}`, {
        host: '127.0.0.1',
        port,
        logger: quiet,
        handleSignals: false,
        prefix: `itls-${uuid()}`,
        ...(tls === undefined ? {} : { tls }),
    });

    // background failures are emitted only when something is listening, and
    // the assertion below is about start() rejecting, not about the noise
    rq.on('error', () => undefined);

    await assert.rejects(() => rq.start());
    await rq.destroy().catch(() => undefined);
    await settle();
};

describe('TLS against a real redis', { skip }, () => {
    after(() => broker.stop());

    describe('a server-authenticated connection', () => {
        it('should complete a verified handshake', async t => {
            const rq = await queue(t, broker.port, {
                tls: { ca: broker.ca, servername: broker.servername },
            });
            const socket = socketOf(rq);

            assert.ok(socket.encrypted, 'the socket is not a TLS socket');
            assert.ok(socket.authorized, socket.authorizationError?.message);
            assert.match(String(socket.getProtocol()), /^TLSv1\.[23]$/);
            assert.equal(
                socket.getPeerCertificate().subject.CN,
                broker.servername,
            );
        });

        it('should carry a message end to end', async t => {
            const tls = { ca: broker.ca, servername: broker.servername };
            const from = await queue(t, broker.port, {
                tls,
                prefix: 'ITlsRt',
                safeDelivery: true,
            });
            const to = await queue(t, broker.port, {
                tls,
                prefix: 'ITlsRt',
                safeDelivery: true,
            });

            const delivered = new Promise(resolve =>
                to.once('message', resolve),
            );

            await from.send(to.name, { hello: 'over tls' });

            assert.deepEqual(await delivered, { hello: 'over tls' });
        });

        it('should share one connection between equal configurations', async t => {
            const tls = { ca: broker.ca, servername: broker.servername };
            const one = await queue(t, broker.port, { tls, prefix: 'ITlsP1' });
            const two = await queue(t, broker.port, {
                tls: { ...tls },
                prefix: 'ITlsP2',
            });

            assert.equal(one.writer, two.writer);
        });

        it('should not reuse it for a different trust anchor', async t => {
            // the pool key has to survive contact with a real socket, not only
            // with the mock that never opens one
            const one = await queue(t, broker.port, {
                tls: { ca: broker.ca, servername: broker.servername },
                prefix: 'ITlsP3',
            });
            const two: any = new RedisQueue('ITlsP4', {
                host: '127.0.0.1',
                port: broker.port,
                logger: quiet,
                handleSignals: false,
                tls: { ca: broker.cert, servername: broker.servername },
            });

            t.after(() => two.destroy().catch(() => undefined));

            assert.notEqual(one.poolKey, two.poolKey);
            assert.equal(two.writer, undefined);
        });
    });

    describe('a broker reached at an address, not a name', () => {
        // the shape a deployment whose brokers announce IP addresses runs in:
        // the certificate cannot carry an address nobody knew when it was
        // issued, so identity has to be pinned instead of inferred from the
        // host being dialled
        it('should refuse an address the certificate does not carry', async () => {
            // the naive attempt - default verification checks the certificate
            // against 127.0.0.1, which is in no SAN, and fails
            await refuses(broker.port, { ca: broker.ca });
        });

        it('should verify against a pinned name instead of the address', async t => {
            const rq = await queue(t, broker.port, {
                tls: { ca: broker.ca, servername: broker.servername },
            });
            const socket = socketOf(rq);

            assert.ok(socket.authorized, socket.authorizationError?.message);
            assert.equal(
                socket.getPeerCertificate().subject.CN,
                broker.servername,
            );
            // and the address really is not what was verified
            assert.equal(rq.options.host, '127.0.0.1');
            assert.notEqual(broker.servername, '127.0.0.1');
        });

        it('should verify at an address it has never seen before', async t => {
            // the autoscaling case: a broker is replaced and comes back on a
            // different address. The certificate names an identity, not a
            // location, so the new address needs no certificate work at all -
            // nothing is issued, re-issued or reloaded
            const other = await otherAddress(broker.port);

            if (!other) {
                t.skip('this platform has only one loopback address');

                return;
            }

            const first = await queue(t, broker.port, {
                tls: { ca: broker.ca, servername: broker.servername },
            });
            const moved = await queue(t, broker.port, {
                host: other,
                tls: { ca: broker.ca, servername: broker.servername },
            });

            assert.equal(first.options.host, '127.0.0.1');
            assert.equal(moved.options.host, other);
            assert.ok(
                socketOf(moved).authorized,
                socketOf(moved).authorizationError?.message,
            );
            // a different address is a different connection, not a reused one
            assert.notEqual(first.poolKey, moved.poolKey);
            assert.notEqual(first.writer, moved.writer);
        });

        it('should still gate on the authority that signed it', async () => {
            // pinning a name must not become a way to accept anyone who claims
            // it: a broker without a certificate from this CA is still refused
            await refuses(broker.port, {
                servername: broker.servername,
            });
        });
    });

    describe('a broker that will not be reached in the clear', () => {
        it('should refuse a plaintext connection', async () => {
            // the broker runs with `--port 0`, so there is no plaintext
            // listener to fall back to and no way to reach it by accident
            await refuses(broker.port, false);
        });

        it('should refuse a certificate it cannot verify', async () => {
            await refuses(broker.port, true);
        });

        it('should refuse a name the certificate does not carry', async () => {
            // the certificate is issued for localhost; asking for another name
            // must fail rather than pass on the strength of the CA alone
            await refuses(broker.port, {
                ca: broker.ca,
                servername: 'not-the-broker.invalid',
            });
        });
    });

    describe('the environment configuration', () => {
        it('should encrypt a queue that asks for nothing in code', async t => {
            const saved = { ...process.env };

            process.env.IMQ_REDIS_TLS_CA_FILE = broker.paths.ca;
            process.env.IMQ_REDIS_TLS_SERVERNAME = broker.servername;

            t.after(() => {
                delete process.env.IMQ_REDIS_TLS_CA_FILE;
                delete process.env.IMQ_REDIS_TLS_SERVERNAME;
                Object.assign(process.env, saved);
            });

            const rq = await queue(t, broker.port, { prefix: 'ITlsEnv' });

            assert.ok(socketOf(rq).encrypted);
            assert.ok(socketOf(rq).authorized);
        });
    });
});

describe('mutual TLS against a real redis', { skip: skipMutual }, () => {
    after(() => mutualBroker.stop());

    it('should present a client certificate the broker accepts', async t => {
        const rq = await queue(t, mutualBroker.port, {
            prefix: 'IMtls',
            tls: {
                ca: mutualBroker.ca,
                cert: mutualBroker.cert,
                key: mutualBroker.key,
                servername: mutualBroker.servername,
            },
        });
        const socket = socketOf(rq);

        assert.ok(socket.authorized, socket.authorizationError?.message);
        const presented = socket.getCertificate();

        assert.ok(presented && 'subject' in presented, 'no client certificate');
        assert.equal(presented.subject.CN, 'imq-integration-client');
    });

    it('should be refused when it presents none', async () => {
        // proves the broker really is enforcing, so the test above means
        // something more than a certificate having been offered
        await refuses(mutualBroker.port, {
            ca: mutualBroker.ca,
            servername: mutualBroker.servername,
        });
    });
});
