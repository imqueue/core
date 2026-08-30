/*!
 * RedisQueue lease-holding tests.
 *
 * Covers what safe delivery guarantees: a message stays checked out to its
 * worker until the listeners are done with it, and the watcher decides
 * abandonment from the broker's client list plus the processing budget rather
 * than from a hand-off deadline.
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
import '../mocks/index.js';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { randomUUID as uuid } from 'node:crypto';
import { describe, it, afterEach, mock, type Mock } from 'node:test';
import { RedisQueue } from '../../src/index.js';
import { makeLogger } from '../helpers/index.js';
import { RedisClientMock } from '../mocks/index.js';

process.setMaxListeners(100);

const QS = (): any => (RedisClientMock as any).__queues__;

/** This process, as it is stamped into a worker key */
const SELF = `pid:${process.pid}:host:${hostname()}`;
/** A process that never connected, so never appears in CLIENT LIST */
const GHOST = 'pid:999999:host:ghost-node';

/**
 * Worker keys currently holding a message for the given queue. Scoped by name
 * because the redis mock's key space is shared across the whole suite.
 */
const leases = (name: string): string[] =>
    Object.keys(QS()).filter(
        k => k.startsWith(`imq:${name}:worker:`) && QS()[k]?.length,
    );

/** Lets pending microtasks settle */
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const after = (ms: number): Promise<void> =>
    new Promise(r => setTimeout(r, ms));

const queue = async (t: any, options: any = {}): Promise<any> => {
    const rq: any = new RedisQueue(options.name || uuid(), {
        logger: makeLogger(),
        safeDelivery: true,
        ...options,
    });

    t.after(() => rq.destroy().catch(() => undefined));

    return rq;
};

describe('RedisQueue lease holding', () => {
    afterEach(() => mock.restoreAll());

    describe('through the real reader loop', () => {
        it('should hold the lease for as long as the handler runs', async t => {
            // the whole point, exercised end to end rather than through a
            // stand-in: LPUSH -> BLMOVE into a worker key -> handler -> DEL
            const rq = await queue(t, { name: 'LeaseLive' });

            await rq.start();

            let duringHandler = -1;
            let finish: () => void = () => undefined;

            rq.on('message', () => {
                duringHandler = leases('LeaseLive').length;

                return new Promise<void>(resolve => (finish = resolve));
            });

            await rq.send('LeaseLive', { work: true });
            await after(50);

            assert.equal(duringHandler, 1, 'held while the handler runs');
            assert.equal(
                leases('LeaseLive').length,
                1,
                'and still held afterwards',
            );

            finish();
            await tick();
            await tick();

            assert.equal(
                leases('LeaseLive').length,
                0,
                'released once the handler is done, and not before',
            );
        });

        it('should release at once for a synchronous handler', async t => {
            const rq = await queue(t, { name: 'LeaseSync' });

            await rq.start();
            rq.on('message', () => undefined);

            await rq.send('LeaseSync', { work: true });
            await after(50);

            assert.equal(
                leases('LeaseSync').length,
                0,
                'a synchronous handler offers no later signal',
            );
        });

        it('should release at dispatch when the promise is not returned', async t => {
            // the documented way back to pre-4.0 behaviour: start the work and
            // return nothing. Guards the escape hatch, so a refactor cannot
            // quietly take it away
            const rq = await queue(t, { name: 'LeaseOptOut' });

            await rq.start();

            let finished = false;

            rq.on('message', () => {
                void new Promise<void>(resolve =>
                    setTimeout(() => {
                        finished = true;
                        resolve();
                    }, 200),
                );
            });

            await rq.send('LeaseOptOut', { work: true });
            await after(50);

            assert.equal(
                leases('LeaseOptOut').length,
                0,
                'released before the work finishes, exactly as 3.x did',
            );
            assert.equal(finished, false, 'and the work really is still going');
        });

        it('should release on a rejection rather than retry forever', async t => {
            const rq = await queue(t, { name: 'LeaseThrow' });

            await rq.start();
            rq.on('message', async () => {
                throw new Error('handler failed');
            });

            await rq.send('LeaseThrow', { work: true });
            await after(50);

            assert.equal(
                leases('LeaseThrow').length,
                0,
                'a handler that threw has still had its turn',
            );
        });

        it('should stamp the owning process into the lease', async t => {
            const rq = await queue(t, { name: 'LeaseOwner' });

            await rq.start();
            rq.on('message', () => new Promise<void>(() => undefined));

            await rq.send('LeaseOwner', { work: true });
            await after(50);

            const [key] = leases('LeaseOwner');

            assert.ok(key, 'a lease was taken');
            assert.ok(key.includes(`:${SELF}:`), `owner missing from ${key}`);
        });
    });

    describe('dispatch', () => {
        it('should report nothing pending for a synchronous listener', async t => {
            const rq = await queue(t);

            rq.on('message', () => undefined);

            const pending = rq.process([
                rq.key,
                rq.pack({ id: 'x', message: {}, from: 'F' }),
            ]);

            assert.deepEqual(pending, []);
        });

        it('should report every promise the listeners returned', async t => {
            const rq = await queue(t);

            rq.on('message', async () => undefined);
            rq.on('message', () => undefined);
            rq.on('message', async () => undefined);

            const pending = rq.process([
                rq.key,
                rq.pack({ id: 'x', message: {}, from: 'F' }),
            ]);

            assert.equal(pending.length, 2, 'only the async ones are pending');
        });

        it('should still remove a once listener and use its result', async t => {
            const rq = await queue(t);

            rq.once('message', async () => undefined);

            const pending = rq.process([
                rq.key,
                rq.pack({ id: 'x', message: {}, from: 'F' }),
            ]);

            assert.equal(pending.length, 1, 'its return value still counts');
            assert.equal(
                rq.listenerCount('message'),
                0,
                'once must still remove itself, as emit() would have',
            );
        });

        it('should report nothing pending for an unreadable message', async t => {
            const rq = await queue(t);

            rq.on('error', () => undefined);

            assert.deepEqual(rq.process([rq.key, 'not-packed']), []);
        });
    });

    describe('abandonment decision', () => {
        it('should reclaim a lease whose owner is gone', async t => {
            const rq = await queue(t);
            const now = Date.now();
            // deadline far ahead: only the missing owner decides this
            const key = `imq:Q:worker:abc:${GHOST}:${now + 300000}`;

            assert.equal(rq.isAbandoned(key, now, new Set([SELF])), true);
        });

        it('should leave a lease alone while its owner is connected', async t => {
            const rq = await queue(t);
            const now = Date.now();
            const key = `imq:Q:worker:abc:${SELF}:${now + 300000}`;

            assert.equal(rq.isAbandoned(key, now, new Set([SELF])), false);
        });

        it('should reclaim from a live owner once the budget is spent', async t => {
            // the case liveness cannot see: the worker is up, connected and
            // serving other messages, but one handler has wedged on this one
            const rq = await queue(t);
            const now = Date.now();
            const key = `imq:Q:worker:abc:${SELF}:${now - 1000}`;

            assert.equal(rq.isAbandoned(key, now, new Set([SELF])), true);
        });

        it('should honour a spent budget even when liveness is unknown', async t => {
            const rq = await queue(t);
            const now = Date.now();

            assert.equal(
                rq.isAbandoned(`imq:Q:worker:abc:${SELF}:${now - 1}`, now),
                true,
            );
        });

        it('should not guess when liveness is unknown', async t => {
            const rq = await queue(t);
            const now = Date.now();
            const key = `imq:Q:worker:abc:${GHOST}:${now + 300000}`;

            // guessing "disconnected" would re-deliver running work
            assert.equal(rq.isAbandoned(key, now, undefined), false);
        });

        it('should honour a bare deadline on a 3.x key', async t => {
            const rq = await queue(t);
            const now = Date.now();

            assert.equal(
                rq.isAbandoned(`imq:Q:worker:abc:${now - 1000}`, now),
                true,
            );
            assert.equal(
                rq.isAbandoned(`imq:Q:worker:abc:${now + 60000}`, now),
                false,
            );
        });

        it('should stay parseable by a 3.x watcher', async t => {
            const rq = await queue(t, { name: 'Compat' });

            await rq.start();
            rq.on('message', () => new Promise<void>(() => undefined));

            await rq.send('Compat', { work: true });
            await after(50);

            // the 3.x parser takes the queue off the front and the deadline off
            // the end; the owner sits between, where it is not looked at
            const kp = leases('Compat')[0].split(':');
            const deadline = Number(kp.pop());

            assert.equal(`${kp.shift()}:${kp.shift()}`, 'imq:Compat');
            assert.ok(
                Number.isFinite(deadline),
                'a 3.x watcher must find a number, not the owner string, or ' +
                    'it would reclaim a live lease during a rolling upgrade',
            );
        });
    });

    describe('reconnect grace', () => {
        it('should give a vanished owner one sweep before reclaiming', async t => {
            const rq = await queue(t);
            const present = `id=1 name=imq:Q:writer:${GHOST}`;

            assert.equal(rq.connectedOwners(present).has(GHOST), true);
            // a reconnect backoff can take tens of seconds
            assert.equal(rq.connectedOwners('').has(GHOST), true);
            assert.equal(rq.connectedOwners('').has(GHOST), false);
        });
    });

    describe('maintenance sweep', () => {
        it('should re-queue a message whose owner died', async t => {
            const rq = await queue(t, { name: 'SweepDead' });

            await rq.start();

            const dead = `imq:SweepDead:worker:abc:${GHOST}:${
                Date.now() + 300000
            }`;

            QS()[dead] = ['MSG'];

            await rq.processWatch(`id=1 name=imq:SweepDead:writer:${SELF}`);

            assert.deepEqual(QS()['imq:SweepDead'] || [], ['MSG']);
        });

        it('should read CLIENT LIST once per tick, not once per consumer', async t => {
            const rq = await queue(t, { cleanup: true });

            await rq.start();
            t.after(() => rq.destroy(true).catch(() => undefined));

            const client: Mock<any> = mock.method(rq.writer, 'client');

            await rq.runSafeCheck();

            const lists = client.mock.calls.filter(
                (c: any) => String(c.arguments[0]).toUpperCase() === 'LIST',
            );

            assert.equal(lists.length, 1, 'exactly one CLIENT LIST per tick');
        });

        it('should delete nothing when CLIENT LIST cannot be read', async t => {
            const rq = await queue(t, { cleanup: true });

            await rq.start();
            t.after(() => rq.destroy(true).catch(() => undefined));

            mock.method(rq.writer, 'client', async () => {
                throw new Error('LIST failed');
            });

            const del: Mock<any> = mock.method(rq.writer, 'del');

            await rq.runSafeCheck();

            // unreadable means unknown, never "nobody owns anything"
            assert.equal(del.mock.callCount(), 0);
        });

        it('should pace the sweep by watcherCheckDelay, not by the budget', async t => {
            const rq = await queue(t, {
                safeDeliveryTtl: 300000,
                watcherCheckDelay: 2000,
            });

            await rq.start();

            assert.equal((rq.safeCheckInterval as any)._idleTimeout, 2000);
        });
    });
});
