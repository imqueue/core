/*!
 * RedisQueue Unit Tests
 *
 * Merged suite: core RedisQueue behaviour plus cleanup, cleanup grace period,
 * connect() fallbacks, error handling, lifecycle, processCleanup branches,
 * processDelayed branches, publish, safe delivery, send and unsubscribe.
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
import '../mocks';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { describe, it, beforeEach, afterEach, mock, Mock } from 'node:test';
import Redis from 'ioredis';
import { RedisQueue, IMQMode } from '../../src';
import { escapeRegExp, sha1 } from '../../src/helpers';
import { makeLogger } from '../helpers';
import { logger, RedisClientMock } from '../mocks';

process.setMaxListeners(100);

const QS = (): any => (RedisClientMock as any).__queues__;
const CL = (): any => (RedisClientMock as any).__clientList;

describe('RedisQueue', () => {
    it('should be a class', () => {
        assert.equal(typeof RedisQueue, 'function');
    });

    it('should implement IMessageQueue interface', () => {
        assert.equal(typeof RedisQueue.prototype.start, 'function');
        assert.equal(typeof RedisQueue.prototype.stop, 'function');
        assert.equal(typeof RedisQueue.prototype.send, 'function');
        assert.equal(typeof RedisQueue.prototype.destroy, 'function');
    });

    describe('constructor()', () => {
        it('should not throw', async () => {
            const instances: RedisQueue[] = [];
            assert.doesNotThrow(() => instances.push(new (<any>RedisQueue)()));
            assert.doesNotThrow(() =>
                instances.push(new RedisQueue('IMQUnitTests')),
            );
            assert.doesNotThrow(() =>
                instances.push(new RedisQueue('IMQUnitTests', {})),
            );
            assert.doesNotThrow(() =>
                instances.push(
                    new RedisQueue('IMQUnitTests', { useGzip: true }),
                ),
            );

            await Promise.all(instances.map(instance => instance.destroy()));
        });
    });

    describe('start()', () => {
        it('should throw if no name provided', async () => {
            const rq = new (<any>RedisQueue)();
            try {
                await rq.start();
            } catch (err) {
                assert.ok(err instanceof TypeError);
            }
            rq.destroy().catch();
        });

        it('should create reader connection', async () => {
            try {
                const rq: any = new RedisQueue(uuid(), { logger });
                await rq.start();
                assert.ok(rq.reader instanceof Redis);
                await rq.destroy();
            } catch (err) {
                console.error(err);
            }
        });

        it('should create shared writer connection', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            assert.ok(rq.writer instanceof Redis);
            await rq.destroy();
        });

        it('should create single watcher connection', async () => {
            const rq1: any = new RedisQueue(uuid(), { logger });
            const rq2: any = new RedisQueue(uuid(), { logger });
            await rq1.start();
            await rq2.start();
            assert.equal(await rq1.watcherCount(), 1);
            assert.equal(await rq2.watcherCount(), 1);
            await rq1.destroy();
            await rq2.destroy();
        });

        it('should restart stopped queue', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            await rq.stop();
            await rq.start();
            assert.ok(rq.reader instanceof Redis);
            await rq.destroy();
        });

        it('should not fail on double start', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            let passed = true;
            try {
                await rq.start();
                await rq.start();
            } catch {
                passed = false;
            }
            assert.equal(passed, true);
            await rq.destroy();
        });
    });

    describe('stop()', () => {
        it('should stop reading messages from queue', async () => {
            const name = uuid();
            const rq: any = new RedisQueue(name, { logger });
            await rq.start();
            assert.ok(rq.reader instanceof Redis);
            await rq.stop();
            assert.ok(!rq.reader);
            await rq.destroy();
        });
    });

    describe('send()', () => {
        it('should send given message to a given queue', (t, done) => {
            const message: any = { hello: 'world' };
            const rqFrom = new RedisQueue('IMQUnitTestsFrom', { logger });
            const rqTo = new RedisQueue('IMQUnitTestsTo', { logger });

            rqTo.on('message', (msg, id, from) => {
                assert.deepEqual(msg, message);
                assert.notEqual(id, undefined);
                assert.equal(from, 'IMQUnitTestsFrom');
                rqFrom.destroy().catch();
                rqTo.destroy().catch();
                done();
            });

            rqFrom.start().then(() => {
                rqTo.start().then(() => {
                    rqFrom.send('IMQUnitTestsTo', message).catch();
                });
            });
        });

        it('should guaranty message delivery if safeDelivery is on', (t, done) => {
            // it is hard to emulate mq crash at a certain time of
            // its runtime execution, so we simply assume delivery works itself
            // for the moment. dumb test but better than nothing :(
            const message: any = { hello: 'safe delivery' };
            const rq = new RedisQueue('IMQSafe', {
                logger,
                safeDelivery: true,
            });

            rq.on('message', msg => {
                assert.deepEqual(msg, message);
                rq.destroy().catch();
                done();
            });

            rq.start().then(async () => rq.send('IMQSafe', message));
        });

        it('should deliver message with the given delay', (t, done) => {
            const message: any = { hello: 'world' };
            const delay: number = 1000;
            const rqFrom = new RedisQueue('IMQUnitTestsFromD', { logger });
            const rqTo = new RedisQueue('IMQUnitTestsToD', { logger });

            let start: number;

            rqTo.on('message', (msg, id, from) => {
                assert.ok(Date.now() - start >= delay);
                assert.deepEqual(msg, message);
                assert.notEqual(id, undefined);
                assert.equal(from, 'IMQUnitTestsFromD');
                rqFrom.destroy().catch();
                rqTo.destroy().catch();
                done();
            });

            rqFrom.start().then(() => {
                rqTo.start().then(() => {
                    start = Date.now();
                    rqFrom.send('IMQUnitTestsToD', message, delay).catch();
                });
            });
        });

        it('should emit an error and keep reading on invalid message', (t, done) => {
            const message: any = { hello: 'safe delivery' };
            const rq: any = new RedisQueue('IMQSafeErr', {
                logger,
                safeDelivery: true,
                safeDeliveryTtl: 500,
            });
            let sawError = false;

            rq.on('error', () => {
                sawError = true;
            });
            rq.on('message', (msg: any) => {
                assert.deepEqual(msg, message);
                assert.ok(
                    sawError,
                    'error must be emitted for the invalid message',
                );
                rq.destroy().catch(() => undefined);
                done();
            });

            rq.start().then(async () => {
                // inject an invalid payload directly into the queue list;
                // the read loop must emit an error for it and survive to
                // deliver the next (valid) message
                (Redis as any).__queues__['imq:IMQSafeErr'] = ['%invalid%'];
                await rq.send('IMQSafeErr', message);
            });
        });
    });

    describe('destroy()', () => {
        let rq: any;

        beforeEach(async () => {
            rq = new RedisQueue(uuid(), { logger });
            await rq.start();
        });

        it('should destroy all connections', async () => {
            await rq.destroy();
            assert.ok(!rq.watcher);
            assert.ok(!rq.reader);
            assert.ok(!rq.writer);
        });

        it('should remove all event listeners', async () => {
            await rq.destroy();
            assert.equal(rq.listenerCount(), 0);
        });
    });

    describe('clear()', () => {
        it('should clean-up queue data in redis', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            rq.clear();
            assert.ok(!(await rq.writer.exists(rq.key)));
            assert.ok(!(await rq.writer.exists(`${rq.key}:delayed`)));
            rq.destroy().catch();
        });
    });

    describe('processCleanup()', () => {
        it('should perform cleanup when cleanup option is enabled', async () => {
            const rq: any = new RedisQueue(uuid(), {
                logger,
                cleanup: true,
                cleanupFilter: 'test*',
            });
            await rq.start();

            // Call processCleanup directly
            const result = await rq.processCleanup();
            assert.equal(result, rq);

            await rq.destroy();
        });

        it('should return early when cleanup option is disabled', async () => {
            const rq: any = new RedisQueue(uuid(), {
                logger,
                cleanup: false,
            });
            await rq.start();

            const result = await rq.processCleanup();
            assert.equal(result, undefined);

            await rq.destroy();
        });
    });

    describe('lock/unlock methods', () => {
        it('should handle lock/unlock when writer is null', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            // Don't start, so writer will be null

            const lockResult = await rq.lock();
            assert.equal(lockResult, false);

            const unlockResult = await rq.unlock();
            assert.equal(unlockResult, false);

            const isLockedResult = await rq.isLocked();
            assert.equal(isLockedResult, false);

            await rq.destroy();
        });

        it('should handle lock/unlock operations', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();

            // Test locking
            const lockResult = await rq.lock();
            assert.equal(typeof lockResult, 'boolean');

            // Test checking if locked
            const isLockedResult = await rq.isLocked();
            assert.equal(typeof isLockedResult, 'boolean');

            // Test unlocking
            const unlockResult = await rq.unlock();
            assert.equal(typeof unlockResult, 'boolean');

            await rq.destroy();
        });
    });

    describe('utility methods', () => {
        it('should test isPublisher and isWorker methods', async () => {
            const publisherQueue = new RedisQueue(
                uuid(),
                { logger },
                IMQMode.PUBLISHER,
            );
            const workerQueue = new RedisQueue(
                uuid(),
                { logger },
                IMQMode.WORKER,
            );

            assert.equal(publisherQueue.isPublisher(), true);
            assert.equal(publisherQueue.isWorker(), false);

            assert.equal(workerQueue.isPublisher(), false);
            assert.equal(workerQueue.isWorker(), true);

            await workerQueue.destroy();
            await publisherQueue.destroy();
        });

        it('should test key and lockKey methods', async () => {
            const name = uuid();
            const rq: any = new RedisQueue(name, { logger });

            assert.equal(typeof rq.key, 'string');
            assert.ok(String(rq.key).includes(name));

            assert.equal(typeof rq.lockKey, 'string');
            assert.ok(String(rq.lockKey).includes('watch:lock'));

            await rq.destroy();
        });
    });
});

describe('RedisQueue.processCleanup catch path', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should log a warning when processCleanup throws', async () => {
        const logger = makeLogger();
        const warnSpy: Mock<any> = mock.method(logger, 'warn');
        const rq: any = new RedisQueue('CleanupCatch', {
            logger,
            cleanup: true,
        });

        await rq.start();
        // Stub writer.client to throw to hit the catch branch
        mock.method(rq.writer, 'client', () => {
            throw new Error('LIST failed');
        });

        await rq.processCleanup();

        assert.ok(warnSpy.mock.callCount() > 0);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup() grace period', () => {
    afterEach(() => mock.restoreAll());

    it('gives vanished clients one sweep of grace before deleting keys', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'CleanGrace',
            { logger, cleanup: true, cleanupFilter: '*' },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const client = 'imq:Gone:writer:pid:1:host:h';
        QS()['imq:Gone'] = ['pending'];
        CL()[client] = true;
        mock.method(rq.writer, 'scan', async () => ['0', ['imq:Gone']]);

        await rq.processCleanup(); // sweep 1: client connected → protected
        assert.ok(QS()['imq:Gone'], 'connected client keys are protected');

        delete CL()[client];

        await rq.processCleanup(); // sweep 2: just vanished → grace period
        assert.ok(
            QS()['imq:Gone'],
            'recently-vanished client keys must get one sweep of grace',
        );

        await rq.processCleanup(); // sweep 3: still gone → delete
        assert.equal(QS()['imq:Gone'], undefined);
    });
});

describe('RedisQueue.connect() option fallbacks', () => {
    it('should use fallback values when falsy options are provided', async () => {
        const logger = makeLogger();
        // Intentionally provide falsy values to trigger `||` fallbacks in connect()
        const rq: any = new RedisQueue(
            'ConnFallbacks',
            {
                logger,
                port: 0 as unknown as number, // falsy to trigger 6379 fallback
                host: '' as unknown as string, // falsy to trigger 'localhost' fallback
                prefix: '' as unknown as string, // falsy to trigger '' fallback in connectionName
                cleanup: false,
            },
            IMQMode.BOTH,
        );

        await rq.start();

        // Basic sanity: writer/reader/watcher are created
        assert.equal(Boolean(rq.writer), true);
        assert.equal(Boolean(rq.reader), true);
        assert.equal(Boolean(rq.watcher), true);

        await rq.destroy();
    });
});

describe('RedisQueue error handling', () => {
    afterEach(() => mock.restoreAll());

    it('emitError does not throw when no error listener is attached', () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'NoListener',
            { logger },
            IMQMode.PUBLISHER,
        );

        assert.doesNotThrow(() =>
            rq.emitError('OnTest', 'test failure', new Error('x')),
        );
    });

    it('computes lua script checksums at construction time', () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('Sha', { logger }, IMQMode.PUBLISHER);

        assert.equal(
            rq.scripts.moveDelayed.checksum,
            sha1(rq.scripts.moveDelayed.code),
        );
    });

    it('processDelayed falls back to EVAL when script is not cached', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('EvalFb', { logger }, IMQMode.PUBLISHER);
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        rq.on('error', () => undefined);

        mock.method(rq.writer, 'evalsha', () => {
            throw new Error('NOSCRIPT No matching script.');
        });

        const evalCalls: any[] = [];
        rq.writer.eval = (...args: any[]) => {
            evalCalls.push(args);
            return Promise.resolve(0);
        };

        await rq.processDelayed(rq.key);

        assert.equal(evalCalls.length, 1, 'EVAL fallback must be used');
    });

    it('escapes regex metacharacters (escapeRegExp)', () => {
        assert.equal(escapeRegExp('my.app*x?'), 'my\\.app\\*x\\?');
        assert.equal(escapeRegExp('plain'), 'plain');
    });
});

describe('RedisQueue lifecycle', () => {
    afterEach(() => mock.restoreAll());

    it('does not register signal handlers when handleSignals is false', async t => {
        const logger = makeLogger();
        const before = process.listenerCount('SIGTERM');
        const rq: any = new RedisQueue(
            'NoSig',
            { logger, handleSignals: false },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        assert.equal(process.listenerCount('SIGTERM'), before);
    });

    it('registers at most one process-level handler for many queues', async t => {
        const logger = makeLogger();
        const before = process.listenerCount('SIGTERM');
        const a: any = new RedisQueue('Sig1', { logger }, IMQMode.PUBLISHER);
        const b: any = new RedisQueue('Sig2', { logger }, IMQMode.PUBLISHER);
        await a.start();
        t.after(() => a.destroy().catch(() => undefined));
        await b.start();
        t.after(() => b.destroy().catch(() => undefined));

        assert.ok(process.listenerCount('SIGTERM') - before <= 1);
    });

    it('destroy() should NOT clear queue data by default', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'KeepData',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        QS()['imq:KeepData'] = ['pending-message'];

        await rq.destroy();

        assert.deepEqual(
            QS()['imq:KeepData'],
            ['pending-message'],
            'destroying a handle must not wipe shared queue data',
        );
        delete QS()['imq:KeepData'];
    });

    it('destroy(true) should clear queue data', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'WipeData',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        QS()['imq:WipeData'] = ['pending-message'];

        await rq.destroy(true);

        assert.equal(QS()['imq:WipeData'], undefined);
    });

    it('re-elects a watcher via watcherCheckDelay after owner crash', async t => {
        const logger = makeLogger();
        // take control of the shared watcher world
        (RedisClientMock as any).__clientList = {};
        (RedisClientMock as any).__keys = {};

        const rq: any = new RedisQueue('ReElect', {
            logger,
            watcherCheckDelay: 40,
        });
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        assert.ok(rq.watchOwner, 'first instance should own the watcher');

        // simulate an owner crash observed from outside: watcher connection
        // gone, stale lock left behind
        rq.destroyChannel('watcher', rq);
        delete (RedisQueue as any).watchers[rq.redisKey];
        rq.watchOwner = false;

        await new Promise(resolve => setTimeout(resolve, 250));

        assert.ok(
            rq.watchOwner,
            'watcher must be re-elected by the periodic check',
        );
    });

    it('re-subscribes and re-attaches handler after subscription reconnect', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'SubRestore',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const received: any[] = [];
        await rq.subscribe('SubRestore', (data: any) => received.push(data));

        const oldChan = rq.subscription;

        // simulate what scheduleReconnect does: replace the client
        rq.destroyChannel('subscription', rq);
        rq.subscription = undefined;
        await rq.connect('subscription', rq.options);

        assert.notEqual(rq.subscription, oldChan);

        rq.subscription?.emit(
            'message',
            'imq:SubRestore',
            JSON.stringify({ ok: 1 }),
        );

        assert.deepEqual(
            received,
            [{ ok: 1 }],
            'handler must survive a subscription reconnect',
        );
    });

    it('unsubscribe() survives a rejecting quit()', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'QuitRej',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        await rq.subscribe('QuitRej', () => undefined);

        rq.subscription.quit = () => Promise.reject(new Error('boom'));

        await assert.doesNotReject(rq.unsubscribe());
    });
});

describe('RedisQueue.processCleanup connectedKeys RX/filter combinations', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should handle RX_CLIENT_TEST true but filter false case (exclude unmatched prefix)', async () => {
        const name = `PCleanRX_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imqA',
            cleanupFilter: '*',
        });

        await rq.start();

        const writer: any = rq.writer;

        // Stub client('LIST') to include a writer channel with a different prefix,
        // so RX_CLIENT_TEST.test(name) is true but filter.test(name) is false.
        mock.method(writer, 'client', async (cmd: string) => {
            if (cmd === 'LIST') {
                return [
                    'id=1 name=imqZ:Other:writer:pid:1:host:x', // RX true, filter false
                    'id=2 name=imqA:Other:subscription:pid:1:host:x', // RX false, filter true
                ].join('\n');
            }
            return true as any;
        });

        // Return no keys on SCAN to avoid deletions and just walk the branch
        mock.method(writer, 'scan', async () => ['0', []] as any);

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup extra branches', () => {
    it('should remove scanned keys that do not match any connectedKey (different prefix)', async () => {
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imqX',
            cleanupFilter: '*',
        });

        // start to create reader/writer/watcher with connection names
        await rq.start();

        // Create an orphan worker key with a different prefix so it won't include any connectedKey
        const orphanKey = 'imqY:orphan:worker:someuuid:123456';
        (RedisClientMock as any).__queues__[orphanKey] = ['payload'];

        // Sanity: ensure the key is present before cleanup
        assert.ok((RedisClientMock as any).__queues__[orphanKey]);

        await rq.processCleanup();

        // The orphan key should be deleted by cleanup (true branch of keysToRemove filter)
        assert.equal((RedisClientMock as any).__queues__[orphanKey], undefined);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup multi-scan/no-delete branches', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should handle multi-page SCAN (cursor != "0" first) and avoid deletion when keys belong to connected clients', async () => {
        const name = `PClean_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imq',
            cleanupFilter: '*',
        });

        await rq.start();

        const writer: any = rq.writer;

        // Stub scan to first return non-zero cursor with undefined keys (to exercise `|| []`),
        // then return zero cursor with keys that include connectedKey (so no removal happens).
        const scanStub: Mock<any> = mock.method(
            writer,
            'scan',
            async () => undefined,
        );
        scanStub.mock.mockImplementationOnce(
            async () => ['1', undefined] as any,
            0,
        );
        scanStub.mock.mockImplementationOnce(
            async () => ['0', [`imq:${name}:reader:pid:123`]] as any,
            1,
        );

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        // del should not be called because keysToRemove.length === 0
        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup null-match and falsy cleanupFilter', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it("should handle clients.match returning null and cleanupFilter as falsy ('')", async () => {
        const name = `PCleanNull_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imq',
            cleanupFilter: '', // falsy to exercise "|| '*'" in both RegExp and SCAN MATCH
        });

        await rq.start();

        const writer: any = rq.writer;

        // Force clients.match(...) to return null by stubbing client('LIST') to return a string without 'name='
        mock.method(writer, 'client', async (cmd: string) => {
            if (cmd === 'LIST') {
                return 'id=1 flags=x'; // no 'name='
            }
            return true as any;
        });

        // Ensure SCAN returns no keys, to avoid deletions and just cover the branch paths
        mock.method(writer, 'scan', async () => ['0', []] as any);

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});

describe('RedisQueue.processDelayed extra branches', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should emit error when script execution fails', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('ProcessDelayedCatch', { logger });
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const emitErrorStub: Mock<any> = mock.method(
            (RedisQueue as any).prototype,
            'emitError',
            () => undefined,
        );

        // non-NOSCRIPT failures must be reported through emitError
        mock.method(rq.writer, 'evalsha', () => {
            throw new Error('evalsha failed');
        });

        await rq['processDelayed'](rq.key);

        assert.ok(emitErrorStub.mock.callCount() > 0);
        assert.equal(
            emitErrorStub.mock.calls[0].arguments[0],
            'OnProcessDelayed',
        );
    });

    it('should be a silent no-op when writer is not connected', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('ProcessDelayedNoWriter', { logger });
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const emitErrorStub: Mock<any> = mock.method(
            (RedisQueue as any).prototype,
            'emitError',
            () => undefined,
        );

        const originalWriter = rq.writer;
        rq['writer'] = undefined;

        await rq['processDelayed'](rq.key);

        rq['writer'] = originalWriter;

        assert.equal(emitErrorStub.mock.callCount(), 0);
    });
});

describe('RedisQueue.publish()', () => {
    it('should throw when writer is not connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubNoWriter',
            { logger },
            IMQMode.PUBLISHER,
        );

        let thrown: any;
        try {
            await rq.publish({ a: 1 });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('Writer is not connected'));

        await rq.destroy().catch(() => undefined);
    });

    it('should publish to default channel when writer is connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubDefault',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();

        const pubSpy = mock.method((rq as any).writer, 'publish');
        await rq.publish({ hello: 'world' });

        assert.equal(pubSpy.mock.callCount() > 0, true);
        const [channel, msg] = pubSpy.mock.calls[0].arguments;
        assert.equal(channel, 'imq:PubDefault');
        assert.doesNotThrow(() => JSON.parse(msg));

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });

    it('should publish to provided toName channel when given', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubOther',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();

        const pubSpy = mock.method((rq as any).writer, 'publish');
        await rq.publish({ t: true }, 'OtherChannel');

        assert.equal(pubSpy.mock.callCount() > 0, true);
        const [channel] = pubSpy.mock.calls[0].arguments;
        assert.equal(channel, 'imq:OtherChannel');

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue safe delivery lease handling', () => {
    afterEach(() => mock.restoreAll());

    it('processKeys: requeues messages whose lease deadline expired', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('LeaseExp', {
            logger,
            safeDelivery: true,
        });
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const expired = `imq:LeaseExp:worker:abc:${Date.now() - 60000}`;
        QS()[expired] = ['MSG'];

        await rq.processKeys([expired], Date.now());

        assert.deepEqual(
            QS()['imq:LeaseExp'] || [],
            ['MSG'],
            'expired lease must be moved back to the main queue',
        );
    });

    it('processKeys: leaves in-flight messages with a fresh lease alone', async t => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('LeaseFresh', {
            logger,
            safeDelivery: true,
        });
        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const fresh = `imq:LeaseFresh:worker:abc:${Date.now() + 60000}`;
        QS()[fresh] = ['MSG'];

        await rq.processKeys([fresh], Date.now());

        assert.deepEqual(
            QS()[fresh],
            ['MSG'],
            'fresh lease must not be stolen from a live worker',
        );
        assert.equal((QS()['imq:LeaseFresh'] || []).length, 0);
    });

    // regression guard for the bounded-timeout read loop: a message arriving
    // long after the reader started must still be delivered
    it('delivers safe-mode messages that arrive after pop timeouts', (t, done) => {
        const logger = makeLogger();
        const message: any = { late: true };
        const rq: any = new RedisQueue('LateSafe', {
            logger,
            safeDelivery: true,
            safeDeliveryTtl: 200,
        });

        rq.on('message', (msg: any) => {
            assert.deepEqual(msg, message);
            rq.destroy().catch(() => undefined);
            done();
        });

        rq.start().then(() => {
            setTimeout(() => {
                rq.send('LateSafe', message).catch(() => undefined);
            }, 400);
        });
    });
});

describe('RedisQueue.send() extra branches', () => {
    it('should throw when writer is still uninitialized after start()', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'SendNoWriter',
            { logger },
            IMQMode.PUBLISHER,
        );
        // Force start to be a no-op so writer remains undefined
        mock.method(rq, 'start', async () => rq);

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('unable to initialize queue'));

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.send() worker-only mode', () => {
    it('should throw when called in WORKER only mode', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'WorkerOnly',
            { logger },
            IMQMode.WORKER,
        );

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('WORKER only mode'));

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.unsubscribe()', () => {
    it('should cleanup subscription channel when present', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('SubUnsub', { logger });
        await rq.start();

        const handler = mock.fn();
        await rq.subscribe('SubUnsub', handler);

        assert.ok(rq.subscription);
        assert.equal(rq.subscriptionName, 'SubUnsub');

        const unsubSpy = mock.method(rq.subscription, 'unsubscribe');
        const ralSpy = mock.method(rq.subscription, 'removeAllListeners');
        const disconnectSpy = mock.method(rq.subscription, 'disconnect');
        const quitSpy = mock.method(rq.subscription, 'quit');

        await rq.unsubscribe();

        assert.equal(unsubSpy.mock.callCount(), 1);
        assert.equal(ralSpy.mock.callCount(), 1);
        assert.equal(disconnectSpy.mock.callCount(), 1);
        assert.equal(quitSpy.mock.callCount(), 1);
        assert.equal(rq.subscription, undefined);
        assert.equal(rq.subscriptionName, undefined);

        mock.restoreAll();

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.queueLength()', () => {
    it('should return 0 when the writer is not connected', async () => {
        const rq: any = new RedisQueue('QLenNoWriter', { logger });

        assert.equal(await rq.queueLength(), 0);

        await rq.destroy().catch(() => undefined);
    });

    it('should return the number of pending messages in the queue', async () => {
        const rq: any = new RedisQueue('QLenCount', { logger });
        await rq.start();

        assert.equal(await rq.queueLength(), 0);

        await rq.send('QLenCount', { n: 1 });
        await rq.send('QLenCount', { n: 2 });

        assert.equal(await rq.queueLength(), 2);

        await rq.destroy(true).catch(() => undefined);
    });
});

describe('RedisQueue.available getter', () => {
    it('should be available before a writer connection exists', () => {
        const rq: any = new RedisQueue('AvailNoWriter', { logger });

        assert.equal(rq.available, true);

        rq.destroy().catch(() => undefined);
    });

    it('should reflect the writer connection status once started', async () => {
        const rq: any = new RedisQueue('AvailStarted', { logger });
        await rq.start();

        assert.equal(rq.available, true);

        rq.writer.status = 'reconnecting';
        assert.equal(rq.available, false);

        rq.writer.status = 'ready';
        assert.equal(rq.available, true);

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.onWatchMessage()', () => {
    it('should process delayed messages for ttl expiry keys', async () => {
        const rq: any = new RedisQueue('WatchTtl', { logger });
        await rq.start();

        const processDelayed = mock.method(rq, 'processDelayed');

        // keyspace event: <prefix>:<name>:<id>:ttl
        await rq.onWatchMessage('__keyspace__', `imq:WatchTtl:someid:ttl`);

        assert.equal(processDelayed.mock.callCount(), 1);
        assert.equal(processDelayed.mock.calls[0].arguments[0], 'imq:WatchTtl');

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });

    it('should ignore keyspace events that are not ttl expiries', async () => {
        const rq: any = new RedisQueue('WatchNonTtl', { logger });
        await rq.start();

        const processDelayed = mock.method(rq, 'processDelayed');

        await rq.onWatchMessage('__keyspace__', `imq:WatchNonTtl:someid:set`);

        assert.equal(processDelayed.mock.callCount(), 0);

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });

    it('should emit an error when delayed processing throws', async () => {
        const rq: any = new RedisQueue('WatchErr', { logger });
        await rq.start();

        mock.method(rq, 'processDelayed', () => {
            throw new Error('boom');
        });
        const emitError = mock.method(rq, 'emitError');

        await rq.onWatchMessage('__keyspace__', `imq:WatchErr:someid:ttl`);

        assert.equal(emitError.mock.callCount(), 1);
        assert.equal(emitError.mock.calls[0].arguments[0], 'OnWatch');

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue reconnection', () => {
    it('scheduleReconnect() marks the channel reconnecting and backs off', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const rq: any = new RedisQueue('ReconnSchedule', { logger });

        rq.scheduleReconnect('reader');

        assert.equal(rq.reconnecting.reader, true);
        assert.equal(rq.reconnectAttempts.reader, 1);

        // a second schedule while already reconnecting is a no-op
        rq.scheduleReconnect('reader');
        assert.equal(rq.reconnectAttempts.reader, 1);

        t.mock.timers.reset();
        await rq.destroy().catch(() => undefined);
    });

    it('scheduleReconnect() does nothing once destroyed', async () => {
        const rq: any = new RedisQueue('ReconnDestroyed', { logger });
        await rq.destroy().catch(() => undefined);

        rq.scheduleReconnect('writer');

        assert.equal(rq.reconnecting.writer, undefined);
    });

    it('reconnectNow() re-establishes a channel and resets its counters', async () => {
        const rq: any = new RedisQueue('ReconnNow', { logger });
        await rq.start();

        rq.reconnectAttempts.reader = 3;
        rq.reconnecting.reader = true;

        await rq.reconnectNow('reader');

        assert.equal(rq.reconnectAttempts.reader, 0);
        assert.equal(rq.reconnecting.reader, false);
        assert.ok(rq.reader instanceof Redis);

        await rq.destroy().catch(() => undefined);
    });

    it('reconnectNow() bails out without reconnecting when destroyed', async () => {
        const rq: any = new RedisQueue('ReconnNowDestroyed', { logger });
        await rq.destroy().catch(() => undefined);

        rq.reconnecting.writer = true;
        await rq.reconnectNow('writer');

        assert.equal(rq.reconnecting.writer, false);
    });

    it('reconnectNow() reconnects the writer channel', async () => {
        const rq: any = new RedisQueue('ReconnWriter', { logger });
        await rq.start();

        await rq.reconnectNow('writer');

        assert.ok(rq.writer instanceof Redis);

        await rq.destroy().catch(() => undefined);
    });

    it('reconnectNow() reconnects the watcher channel', async () => {
        const rq: any = new RedisQueue('ReconnWatcher', { logger });
        await rq.start();

        await rq.reconnectNow('watcher');

        assert.ok(rq.watcher instanceof Redis);

        await rq.destroy().catch(() => undefined);
    });

    it('reconnectNow() reconnects the subscription channel', async () => {
        const rq: any = new RedisQueue('ReconnSub', { logger });
        await rq.start();
        await rq.subscribe('ReconnSub', mock.fn());

        await rq.reconnectNow('subscription');

        assert.ok(rq.subscription instanceof Redis);

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.subscribe() validation', () => {
    it('rejects when no channel name is provided', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await assert.rejects(
            rq.subscribe('', () => undefined),
            TypeError,
        );

        await rq.destroy().catch(() => undefined);
    });

    it('rejects when subscribing to a different channel', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.subscribe('ChanA', () => undefined);

        await assert.rejects(
            rq.subscribe('ChanB', () => undefined),
            /Invalid channel name/,
        );

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue verbose logging & write errors', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('logs through verbose() when the verbose option is enabled', async () => {
        const info: Mock<any> = mock.method(logger, 'info');
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        rq.verbose('hello world');

        assert.ok(info.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('reports LPUSH write errors to the error handler', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(new Error('lpush failed'));

            return 0;
        });

        const errors: Error[] = [];

        await rq.send('WriteErrTarget', { a: 1 }, undefined, (err: Error) =>
            errors.push(err),
        );

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /lpush failed/);

        await rq.destroy(true).catch(() => undefined);
    });

    it('reports ZADD write errors for delayed sends', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.writer, 'zadd', (...args: any[]) => {
            args[args.length - 1](new Error('zadd failed'));

            return false;
        });

        const errors: Error[] = [];

        await rq.send('DelayErrTarget', { a: 1 }, 1000, (err: Error) =>
            errors.push(err),
        );

        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /zadd failed/);

        await rq.destroy(true).catch(() => undefined);
    });
});

describe('RedisQueue connection error & clear failures', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('logs and schedules reconnect on a connection error event', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();

        const schedule: Mock<any> = mock.method(
            rq,
            'scheduleReconnect',
            () => undefined,
        );
        const err: any = new Error('connection refused');
        err.code = 'ECONNREFUSED';

        rq.writer.emit('error', err);

        assert.ok(schedule.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('logs when clearing expired keys fails', async () => {
        const errorSpy: Mock<any> = mock.method(logger, 'error');
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        mock.method(rq.writer, 'del', async () => {
            throw new Error('del failed');
        });

        await rq.clear();

        assert.ok(errorSpy.mock.callCount() > 0);

        await rq.destroy(true).catch(() => undefined);
    });
});

describe('RedisQueue read loops & connection handlers', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('read() logs when the reader is not initialized', async () => {
        const errorSpy: Mock<any> = mock.method(logger, 'error');
        const rq: any = new RedisQueue(uuid(), { logger });

        assert.equal(rq.read(), rq);
        assert.ok(errorSpy.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('readUnsafe() breaks quietly on a closed connection', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        mock.method(rq.reader, 'brpop', async () => {
            throw new Error('Connection is closed');
        });

        await assert.doesNotReject(rq.readUnsafe());

        await rq.destroy().catch(() => undefined);
    });

    it('readUnsafe() emits an error on an unexpected reader failure', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        mock.method(rq.reader, 'brpop', async () => {
            throw new Error('unexpected boom');
        });

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        await rq.readUnsafe();

        assert.ok(errors.length > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('readSafe() breaks when the reader connection ends', async () => {
        const rq: any = new RedisQueue(uuid(), {
            logger,
            safeDelivery: true,
        });

        await rq.start();
        mock.method(rq.reader, 'blmove', async () => {
            throw new Error('ended');
        });

        await assert.doesNotReject(rq.readSafe());

        await rq.destroy(true).catch(() => undefined);
    });

    it('readSafe() survives a message processing failure', async () => {
        const rq: any = new RedisQueue(uuid(), {
            logger,
            safeDelivery: true,
        });

        await rq.start();

        let n = 0;
        mock.method(rq.reader, 'blmove', async () => {
            if (n++ === 0) {
                return 'a-message';
            }

            rq.destroyed = true;

            return null;
        });
        mock.method(rq, 'process', () => {
            throw new Error('process failed');
        });

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        await rq.readSafe();

        assert.ok(errors.length > 0);

        rq.destroyed = false;
        await rq.destroy(true).catch(() => undefined);
    });

    it('onCloseHandler() marks uninitialized and schedules reconnect', async () => {
        const warnSpy: Mock<any> = mock.method(logger, 'warn');
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();

        const schedule: Mock<any> = mock.method(
            rq,
            'scheduleReconnect',
            () => undefined,
        );

        rq.onCloseHandler('reader')();

        assert.equal(rq.initialized, false);
        assert.ok(warnSpy.mock.callCount() > 0);
        assert.ok(schedule.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('process() ignores messages for a different queue', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        assert.equal(rq.process(['some:other:key', 'data']), rq);

        await rq.destroy().catch(() => undefined);
    });

    it('destroyChannel() is a no-op when the channel has no connection', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        assert.doesNotThrow(() => rq.destroyChannel('subscription'));

        await rq.destroy().catch(() => undefined);
    });

    it('reports SET write errors for delayed sends', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.writer, 'zadd', (...args: any[]) => {
            args[args.length - 1](null);

            return true;
        });
        mock.method(rq.writer, 'set', (...args: any[]) => {
            args[args.length - 1](new Error('set failed'));

            return { catch: () => undefined };
        });

        const errors: Error[] = [];

        await rq.send('SetErrTarget', { a: 1 }, 1000, (err: Error) =>
            errors.push(err),
        );

        assert.ok(errors.some(err => /set failed/.test(err.message)));

        await rq.destroy(true).catch(() => undefined);
    });
});

describe('RedisQueue watcher & connect edge paths', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('connect() returns the existing connection for a channel', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();

        const existing = await rq.connect('reader', rq.options);

        assert.equal(existing, rq.reader);

        await rq.destroy().catch(() => undefined);
    });

    it('processWatch() emits an error and clears the interval on scan failure', async () => {
        const rq: any = new RedisQueue(uuid(), {
            logger,
            safeDelivery: true,
        });

        await rq.start();
        mock.method(rq.writer, 'scan', async () => {
            throw new Error('scan failed');
        });

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        await rq.processWatch();

        assert.ok(errors.length > 0);

        await rq.destroy(true).catch(() => undefined);
    });

    it('initWatcher() logs and rethrows when initialization fails', async () => {
        const errorSpy: Mock<any> = mock.method(logger, 'error');
        const rq: any = new RedisQueue(uuid(), { logger });

        mock.method(rq, 'watcherCount', async () => {
            throw new Error('watcher count failed');
        });

        await assert.rejects(rq.initWatcher(), /watcher count failed/);
        assert.ok(errorSpy.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue signal, reconnect & watch internals', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('noRetryStrategy disables ioredis retries', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();

        assert.equal(rq.reader.options.retryStrategy(), null);

        await rq.destroy().catch(() => undefined);
    });

    it('freeAndExit() releases watcher locks and exits', async () => {
        const exit: Mock<any> = mock.method(
            process,
            'exit',
            (() => undefined) as any,
        );
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        rq.watchOwner = true;
        mock.method(rq, 'unlock', async () => {
            throw new Error('unlock fail');
        });

        await (RedisQueue as any).freeAndExit();

        assert.ok(exit.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('bindSignals() wires a shutdown handler that frees and exits', async () => {
        mock.method(process, 'exit', (() => undefined) as any);

        const prev = (RedisQueue as any).signalsBound;
        (RedisQueue as any).signalsBound = false;

        const before = process.listeners('SIGTERM').slice();
        (RedisQueue as any).bindSignals();
        const added = process
            .listeners('SIGTERM')
            .filter(l => !before.includes(l));

        assert.ok(added.length > 0);

        await (added[0] as any)();
        await new Promise(resolve => setImmediate(resolve));

        for (const sig of ['SIGTERM', 'SIGINT', 'SIGABRT'] as const) {
            for (const l of added) {
                process.removeListener(sig, l as any);
            }
        }

        (RedisQueue as any).signalsBound = prev;
    });

    it('runWatcherCheck() returns early when a check is in flight', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        rq.watcherCheckBusy = true;

        await assert.doesNotReject(rq.runWatcherCheck());

        rq.watcherCheckBusy = false;
        await rq.destroy().catch(() => undefined);
    });

    it('runWatcherCheck() contains errors without throwing', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        rq.watcherCheckBusy = false;
        mock.method(rq, 'watcherCount', async () => {
            throw new Error('watcher count fail');
        });

        await assert.doesNotReject(rq.runWatcherCheck());

        await rq.destroy().catch(() => undefined);
    });

    it('reports LPUSH errors surfaced via a rejected promise', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.writer, 'lpush', () => ({
            catch: (cb: any) => cb(new Error('lpush promise fail')),
        }));

        const errors: Error[] = [];

        await rq.send('LpushProm', { a: 1 }, undefined, (err: Error) =>
            errors.push(err),
        );

        assert.ok(errors.some(err => /lpush promise fail/.test(err.message)));

        await rq.destroy(true).catch(() => undefined);
    });

    it('destroyChannel() logs when quit throws synchronously', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.reader, 'quit', () => {
            throw new Error('quit fail');
        });

        assert.doesNotThrow(() => rq.destroyChannel('reader'));

        // quit was stubbed to throw, so disconnect() never ran to clear the
        // mock reader's poll timer — restore and disconnect for real to avoid
        // leaking the recurring brpop timer
        mock.restoreAll();
        rq.reader?.disconnect();

        await rq.destroy().catch(() => undefined);
    });

    it('destroyChannel() logs when the forced disconnect throws', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq.reader, 'quit', async () => {
            throw new Error('quit rejected');
        });
        mock.method(rq.reader, 'disconnect', () => {
            throw new Error('disconnect fail');
        });

        rq.destroyChannel('reader');
        await new Promise(resolve => setImmediate(resolve));

        // the stubbed disconnect threw before clearing the mock reader's poll
        // timer — restore and disconnect for real to release it
        mock.restoreAll();
        rq.reader?.disconnect();

        await rq.destroy().catch(() => undefined);
    });

    it('scheduleReconnect() clears an existing reconnect timer', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        rq.reconnectTimers.reader = setTimeout(() => undefined, 60000);

        rq.scheduleReconnect('reader');

        assert.ok(rq.reconnectTimers.reader);
        clearTimeout(rq.reconnectTimers.reader);
        rq.reconnectTimers.reader = undefined;

        await rq.destroy().catch(() => undefined);
    });

    it('reconnectNow() clears the pending timer on success', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        rq.reconnectTimers.reader = setTimeout(() => undefined, 60000);

        await rq.reconnectNow('reader');

        assert.equal(rq.reconnectTimers.reader, undefined);

        await rq.destroy().catch(() => undefined);
    });

    it('reconnectNow() reschedules on failure', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        mock.method(rq, 'connect', async () => {
            throw new Error('connect fail');
        });
        const schedule: Mock<any> = mock.method(
            rq,
            'scheduleReconnect',
            () => undefined,
        );

        await rq.reconnectNow('reader');

        assert.ok(schedule.mock.callCount() > 0);

        await rq.destroy().catch(() => undefined);
    });

    it('onErrorHandler() returns early once destroyed', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        rq.destroyed = true;

        assert.doesNotThrow(() =>
            rq.onErrorHandler('reader')(new Error('ignored')),
        );

        rq.destroyed = false;
        await rq.destroy().catch(() => undefined);
    });

    it('watcherCount() returns 0 when CLIENT LIST is empty', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        mock.method(rq.writer, 'client', async () => null);

        assert.equal(await rq.watcherCount(), 0);

        await rq.destroy().catch(() => undefined);
    });

    it('watch() returns early without a writer/watcher', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        assert.equal(rq.watch(), rq);

        await rq.destroy().catch(() => undefined);
    });

    it('watch() emits a config error when SET fails', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        rq.writer = {
            config: () => {
                throw new Error('config fail');
            },
        };
        rq.watcher = {
            __ready__: false,
            on: () => undefined,
            psubscribe: () => ({ catch: () => undefined }),
        };

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        rq.watch();

        assert.ok(errors.length > 0);

        rq.cleanSafeCheckInterval();
        rq.writer = undefined;
        rq.watcher = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('runSafeCheck() cleans the interval when the writer is gone', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await assert.doesNotReject(rq.runSafeCheck());

        await rq.destroy().catch(() => undefined);
    });

    it('ownWatch() emits an error when script loading fails', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        mock.method(rq, 'lock', async () => true);
        mock.method(rq, 'connect', async () => rq.writer);
        mock.method(rq, 'watch', () => rq);
        mock.method(rq.writer, 'script', async () => {
            throw new Error('script fail');
        });

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        await rq.ownWatch();

        assert.ok(errors.length > 0);

        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue remaining guards', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('processKeys() returns early for an empty key list', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await assert.doesNotReject(rq.processKeys([], Date.now()));

        await rq.destroy().catch(() => undefined);
    });

    it('freeAndExit() force-exits when unlocking exceeds the timeout', async () => {
        const exit: Mock<any> = mock.method(
            process,
            'exit',
            (() => undefined) as any,
        );
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();
        rq.watchOwner = true;
        // an unlock that never settles forces the shutdown fallback timer
        mock.method(rq, 'unlock', () => new Promise(() => undefined));

        void (RedisQueue as any).freeAndExit();
        await new Promise(resolve => setTimeout(resolve, 1200));

        assert.ok(exit.mock.callCount() > 0);

        mock.restoreAll();
        rq.watchOwner = false;
        await rq.destroy().catch(() => undefined);
    });
});
