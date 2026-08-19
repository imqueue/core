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
import '../mocks/index.js';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import {
    describe,
    it,
    beforeEach,
    afterEach,
    mock,
    type Mock,
} from 'node:test';
import { Redis } from 'ioredis';
import { RedisQueue, IMQMode } from '../../src/index.js';
import { escapeRegExp, pack, sha1 } from '../../src/helpers/index.js';
import { makeLogger } from '../helpers/index.js';
import { logger, RedisClientMock } from '../mocks/index.js';

process.setMaxListeners(100);

const QS = (): any => (RedisClientMock as any).__queues__;
const CL = (): any => (RedisClientMock as any).__clientList;

/** Lets pending microtasks of fire-and-forget calls settle */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Minimal writer stub tracking `notify-keyspace-events` through CONFIG
 * GET/SET, replying in the RESP2 [name, value] shape or, with `resp3`, as a map
 */
const configWriter = (
    initial: string,
    resp3 = false,
): {
    config: (...args: any[]) => Promise<any>;
    calls: any[][];
    flags: () => string;
} => {
    const param = 'notify-keyspace-events';
    const calls: any[][] = [];
    let flags = initial;

    return {
        calls,
        flags: () => flags,
        config: (...args: any[]): Promise<any> => {
            calls.push(args);

            if (String(args[0]).toUpperCase() === 'GET') {
                return Promise.resolve(
                    resp3 ? { [param]: flags } : [param, flags],
                );
            }

            flags = args[2];

            return Promise.resolve('OK');
        },
    };
};

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

    it('processWatch() emits an error but keeps the maintenance interval on scan failure', async () => {
        const rq: any = new RedisQueue(uuid(), {
            logger,
            safeDelivery: true,
        });

        await rq.start();

        assert.ok(rq.safeCheckInterval, 'interval armed by start()');

        const scan: Mock<any> = mock.method(rq.writer, 'scan', async () => {
            throw new Error('scan failed');
        });

        const errors: Error[] = [];
        rq.on('error', (err: Error) => errors.push(err));

        await rq.processWatch();

        assert.ok(errors.length > 0, 'failure is surfaced');

        // A transient scan failure must not tear the interval down: watch()
        // re-arms it only once per watcher connection (guarded by __ready__),
        // so clearing it here would permanently disable lease recovery and
        // cleanup for that connection.
        assert.ok(
            rq.safeCheckInterval,
            'maintenance interval survives a transient failure',
        );

        // and the next sweep still runs
        scan.mock.restore();
        const ok: Mock<any> = mock.method(rq.writer, 'scan', async () => [
            '0',
            [],
        ]);

        await rq.processWatch();

        assert.equal(ok.mock.callCount(), 1, 'subsequent sweep retries');

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

    it('destroyChannel() drops a blocking reader without a graceful quit', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });

        await rq.start();

        const quitSpy = mock.method(rq.reader, 'quit');
        const disconnectSpy = mock.method(rq.reader, 'disconnect');

        rq.destroyChannel('reader');

        // redis cannot process a QUIT while an infinite BRPOP/BLMOVE is in
        // flight, so asking would leave the socket registered as a consumer of
        // the queue for the whole grace period — long enough to swallow a
        // message meant for whoever owns that queue name next
        assert.equal(quitSpy.mock.callCount(), 0);
        assert.equal(disconnectSpy.mock.callCount(), 1);

        mock.restoreAll();

        await rq.destroy().catch(() => undefined);
    });

    it('destroyChannel() logs when quit throws synchronously', async () => {
        const rq: any = new RedisQueue(uuid(), { logger, verbose: true });

        await rq.start();
        // the writer never blocks, so it is still quit gracefully
        mock.method(rq.writer, 'quit', () => {
            throw new Error('quit fail');
        });

        assert.doesNotThrow(() => rq.destroyChannel('writer'));

        mock.restoreAll();

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

    it('watch() emits a config error when CONFIG fails', async () => {
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
        await tick();

        assert.ok(errors.length > 0);

        rq.cleanSafeCheckInterval();
        rq.writer = undefined;
        rq.watcher = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() enables events when none are configured', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        const writer = configWriter('');

        rq.writer = writer;

        await rq.ensureKeyspaceEvents();

        assert.equal(writer.flags(), 'Ex');

        rq.writer = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() keeps flags configured out of band', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        // an operator (or other code sharing this Redis) asked for generic
        // and hash events, delivered on both channel families
        const writer = configWriter('ghKE');

        rq.writer = writer;

        await rq.ensureKeyspaceEvents();

        // only the missing 'x' is appended - nothing gets dropped
        assert.equal(writer.flags(), 'ghKEx');

        rq.writer = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() does not touch a sufficient config', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        // Redis reports back its own normalised order, e.g. 'Ex' reads as 'xE'
        const writer = configWriter('xE');

        rq.writer = writer;

        await rq.ensureKeyspaceEvents();

        assert.equal(writer.flags(), 'xE');
        assert.deepEqual(
            writer.calls.map(args => args[0]),
            ['GET'],
        );

        rq.writer = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() treats "A" as covering expired events', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        const writer = configWriter('AK');

        rq.writer = writer;

        await rq.ensureKeyspaceEvents();

        // 'A' already implies 'x', so only the 'E' selector is missing
        assert.equal(writer.flags(), 'AKE');

        rq.writer = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() accepts a RESP3 map reply', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        const writer = configWriter('xE', true);

        rq.writer = writer;

        await rq.ensureKeyspaceEvents();

        assert.deepEqual(
            writer.calls.map(args => args[0]),
            ['GET'],
        );

        rq.writer = undefined;
        await rq.destroy().catch(() => undefined);
    });

    it('ensureKeyspaceEvents() leaves config alone when GET is unavailable', async () => {
        const rq: any = new RedisQueue(uuid(), { logger });
        const calls: string[] = [];

        rq.writer = {
            config: (...args: any[]) => {
                calls.push(args[0]);

                return String(args[0]).toUpperCase() === 'GET'
                    ? Promise.reject(new Error('unknown command CONFIG'))
                    : Promise.resolve('OK');
            },
        };

        await assert.rejects(rq.ensureKeyspaceEvents());
        assert.deepEqual(calls, ['GET']);

        rq.writer = undefined;
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

/** Logger which keeps every line it was given, per level */
interface Captured {
    logger: any;
    info: string[];
    warn: string[];
    error: string[];
}

const capturing = (): Captured => {
    const join = (args: any[]): string =>
        args.map(arg => String(arg)).join(' ');
    const captured: Captured = {
        info: [],
        warn: [],
        error: [],
        logger: undefined,
    };

    captured.logger = {
        log: () => undefined,
        info: (...args: any[]) => captured.info.push(join(args)),
        warn: (...args: any[]) => captured.warn.push(join(args)),
        error: (...args: any[]) => captured.error.push(join(args)),
    };

    return captured;
};

const matching = (lines: string[], rx: RegExp): string[] =>
    lines.filter(line => rx.test(line));

describe('RedisQueue write failure logging', () => {
    afterEach(() => mock.restoreAll());

    it('logs the first rejected write of an episode, without payload', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(new Error('WRONGTYPE against a key holding secret-payload'));

            return 0;
        });

        const handled: Error[] = [];
        const id = await rq.send(
            'WriteTarget',
            { pan: '4111111111111111' },
            undefined,
            (err: Error) => handled.push(err),
        );
        const lines = matching(cap.error, /write to queue/);

        assert.equal(typeof id, 'string', 'the returned id must not change');
        assert.equal(handled.length, 1, 'errorHandler must still be called');
        assert.equal(lines.length, 1);
        assert.match(lines[0], /WriteTarget/);
        assert.match(lines[0], /LPUSH/);
        assert.match(lines[0], /WRONGTYPE/);
        assert.match(lines[0], new RegExp(id));
        assert.equal(lines[0].includes('4111111111111111'), false);
        assert.equal(lines[0].includes('secret-payload'), false);
    });

    it('keeps later failures silent until a write succeeds again', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        let fail = true;

        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(
                fail
                    ? Object.assign(new Error('nope'), { code: 'EPIPE' })
                    : null,
            );

            return 0;
        });

        await rq.send('WriteTarget', { a: 1 });
        await rq.send('WriteTarget', { a: 2 });
        await rq.send('WriteTarget', { a: 3 });

        assert.equal(matching(cap.error, /write to queue/).length, 1);
        assert.equal(matching(cap.info, /writes resumed/).length, 0);

        fail = false;
        await rq.send('WriteTarget', { a: 4 });

        const resumed = matching(cap.info, /writes resumed/);

        assert.equal(resumed.length, 1);
        assert.match(resumed[0], /after 3 rejected writes/);

        fail = true;
        await rq.send('WriteTarget', { a: 5 });

        assert.equal(
            matching(cap.error, /write to queue/).length,
            2,
            'a failure after the recovery opens a new episode',
        );
    });

    it('counts one rejection once when callback and promise both fire', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        const failure = Object.assign(new Error('nope'), { code: 'EPIPE' });

        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(failure);

            return Promise.reject(failure);
        });

        const handled: Error[] = [];

        await rq.send('WriteTarget', { a: 1 }, undefined, (err: Error) =>
            handled.push(err),
        );
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(
            matching(cap.error, /write to queue/).length,
            1,
            'one logical failure must open the episode once',
        );
        assert.equal(
            handled.length,
            2,
            'errorHandler keeps being invoked per delivery, as it always was',
        );

        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(null);

            return 0;
        });

        await rq.send('WriteTarget', { a: 2 });

        const resumed = matching(cap.info, /writes resumed/);

        assert.equal(resumed.length, 1);
        assert.match(
            resumed[0],
            /after 1 rejected writes/,
            'the double delivery must count as one rejected write',
        );
    });

    it('does not resume a delayed-write episode until SET succeeds', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        let failSet = true;

        mock.method(rq.writer, 'zadd', (...args: any[]) => {
            args[args.length - 1](null);

            return 0;
        });
        mock.method(rq.writer, 'set', (...args: any[]) => {
            args[args.length - 1](
                failSet
                    ? Object.assign(new Error('nope'), { code: 'EPIPE' })
                    : null,
            );

            return Promise.resolve();
        });

        await rq.send('DelayTarget', { a: 1 }, 1000);

        assert.equal(
            matching(cap.info, /writes resumed/).length,
            0,
            'a successful ZADD alone must not close the episode',
        );
        assert.equal(matching(cap.error, /write to queue/).length, 1);

        failSet = false;
        await rq.send('DelayTarget', { a: 2 }, 1000);

        assert.equal(matching(cap.info, /writes resumed/).length, 1);
    });

    it('reopens the episode even when the recovery logger throws', async t => {
        const errors: string[] = [];
        const broken: any = {
            log: () => {},
            info: (...args: any[]) => {
                if (/writes resumed/.test(args.join(' '))) {
                    throw new Error('logger is broken');
                }
            },
            warn: () => {},
            error: (...args: any[]) => errors.push(args.join(' ')),
        };
        const rq: any = new RedisQueue(uuid(), { logger: broken });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        let fail = true;

        mock.method(rq.writer, 'lpush', (_k: any, _v: any, cb: any) => {
            cb(
                fail
                    ? Object.assign(new Error('nope'), { code: 'EPIPE' })
                    : null,
            );

            return 0;
        });

        await rq.send('WriteTarget', { a: 1 });

        fail = false;
        // the recovery line is swallowed by the throwing logger, but the
        // episode counter was reset before the logger was touched
        await rq.send('WriteTarget', { a: 2 });

        fail = true;
        await rq.send('WriteTarget', { a: 3 });

        assert.equal(
            errors.filter(one => /write to queue/.test(one)).length,
            2,
            'a broken recovery logger must not keep the episode open',
        );
    });

    it('logs a rejected delayed write with the failing operation', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq.writer, 'zadd', (...args: any[]) => {
            args[args.length - 1](new Error('OOM command not allowed'));

            return false;
        });

        await rq.send('DelayTarget', { a: 1 }, 1000);

        const lines = matching(cap.error, /write to queue/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /ZADD/);
        assert.match(lines[0], /OOM/);
    });
});

describe('RedisQueue safe reading interruption logging', () => {
    afterEach(() => mock.restoreAll());

    it('warns when safe reading ends on an unexpected failure', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            safeDelivery: true,
            safeDeliveryTtl: 60000,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq.reader, 'blmove', () =>
            Promise.reject(Object.assign(new Error('nope'), { code: 'EPIPE' })),
        );

        await rq.readSafe();

        const lines = matching(cap.warn, /safe reading of queue/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /EPIPE/);
        assert.equal(lines[0].includes('nope'), false);
    });

    it('neither rejects nor stays quiet on an error whose message throws', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            safeDelivery: true,
            safeDeliveryTtl: 60000,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        const evil = new Error('boom');

        Object.defineProperty(evil, 'message', {
            get() {
                throw new Error('not your business');
            },
        });
        mock.method(rq.reader, 'blmove', () => Promise.reject(evil));

        await assert.doesNotReject(rq.readSafe());
        assert.equal(matching(cap.warn, /safe reading of queue/).length, 1);
    });

    it('stays quiet when the reader connection was closed on purpose', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            safeDelivery: true,
            safeDeliveryTtl: 60000,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq.reader, 'blmove', () =>
            Promise.reject(new Error('Stream connection ended')),
        );

        await rq.readSafe();

        assert.equal(matching(cap.warn, /safe reading of queue/).length, 0);
    });

    it('stays quiet when the reader is gone, as after stop()', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            safeDelivery: true,
            safeDeliveryTtl: 60000,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq.reader, 'blmove', () => {
            delete rq.reader;

            return Promise.reject(new Error('read failed'));
        });

        await rq.readSafe();

        assert.equal(matching(cap.warn, /safe reading of queue/).length, 0);
    });

    it('warns with queue and code when a worker key is not deleted', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            safeDelivery: true,
            safeDeliveryTtl: 60000,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        let popped = 0;

        mock.method(rq.reader, 'blmove', () => {
            if (popped++) {
                delete rq.reader;

                return Promise.resolve(null);
            }

            return Promise.resolve(
                pack({ id: uuid(), message: { a: 1 }, from: 'Sender' }),
            );
        });
        mock.method(rq.writer, 'del', () =>
            Promise.reject(new Error('WRONGTYPE nope')),
        );

        await rq.readSafe();
        await tick();

        const lines = matching(cap.warn, /OnReadSafe: del error/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /WRONGTYPE/);
        assert.equal(/worker/.test(lines[0]), false);
    });
});

describe('RedisQueue watcher check logging', () => {
    afterEach(() => mock.restoreAll());

    it('warns when the watcher existence check itself fails', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        mock.method(rq, 'watcherCount', () =>
            Promise.reject(new Error('LOADING redis is loading')),
        );

        await rq.runWatcherCheck();
        await rq.runWatcherCheck();

        const lines = matching(cap.warn, /watcher check failed/);

        // one line per tick: the pace is bounded by watcherCheckDelay
        assert.equal(lines.length, 2);
        assert.match(lines[0], /LOADING/);
        assert.equal(rq.watcherCheckBusy, false);
    });

    it('does not duplicate the line watcher initialization writes itself', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));
        // the real initWatcher() runs and fails inside, so its own
        // unconditional line is the one under test here
        mock.method(rq, 'watcherCount', () => Promise.resolve(0));
        mock.method(rq, 'lock', () =>
            Promise.reject(new Error('LOADING redis is loading')),
        );

        await rq.runWatcherCheck();

        assert.equal(
            matching(cap.error, /error initializing watcher/).length,
            1,
            'watcher initialization must keep reporting its own failure',
        );
        assert.equal(matching(cap.warn, /watcher check failed/).length, 0);
    });
});

describe('RedisQueue subscription lifecycle logging', () => {
    afterEach(() => mock.restoreAll());

    it('reports a subscription and its restoration unconditionally', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        t.after(() => rq.destroy().catch(() => undefined));

        await rq.subscribe('FlowEvents', () => undefined);

        assert.equal(
            matching(cap.info, /subscribed to channel FlowEvents/).length,
            1,
        );

        await rq.restoreSubscription();

        assert.equal(
            matching(cap.info, /restored subscription to channel FlowEvents/)
                .length,
            1,
        );
    });

    it('warns on every failed reconnection attempt', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), { logger: cap.logger });

        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq, 'connect', () =>
            Promise.reject(
                Object.assign(new Error('down'), {
                    code: 'ECONNREFUSED',
                }),
            ),
        );
        mock.method(rq, 'scheduleReconnect', () => undefined);

        await rq.reconnectNow('reader');
        await rq.reconnectNow('reader');

        const lines = matching(cap.warn, /reconnect of the reader channel/);

        // one line per attempt: the retry pace itself is bounded by the
        // reconnection backoff, so no aggregation is applied here
        assert.equal(lines.length, 2);
        assert.match(lines[0], /ECONNREFUSED/);
    });
});

describe('RedisQueue maintenance shutdown logging', () => {
    afterEach(() => mock.restoreAll());

    it('warns before disabling safe-delivery maintenance for good', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(uuid(), {
            logger: cap.logger,
            host: '127.0.0.99',
            port: 6399,
            safeDelivery: true,
            cleanup: true,
        });

        t.after(() => rq.destroy().catch(() => undefined));

        await rq.runSafeCheck();

        const lines = matching(cap.warn, /safe delivery maintenance stopped/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /safeDelivery true/);
        assert.match(lines[0], /cleanup true/);
    });
});

describe('RedisQueue duplicate-cause logging', () => {
    afterEach(() => mock.restoreAll());

    it('aggregates expired-lease requeues by queue for one pass', async t => {
        const cap = capturing();
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: cap.logger,
            safeDelivery: true,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        const expired = (queue: string, worker: string) =>
            `imq:${queue}:worker:${worker}:${Date.now() - 60000}`;
        const first = expired(name, 'abc-lease');
        const second = expired(name, 'def-lease');
        const other = expired('OtherQueue', 'ghi-lease');

        QS()[first] = ['SECRET-MESSAGE-BODY'];
        QS()[second] = ['SECRET-MESSAGE-BODY-TOO'];
        QS()[other] = ['SECRET-MESSAGE-BODY-THREE'];

        await rq.processKeys([first, second, other], Date.now());

        const lines = matching(cap.warn, /re-queued/);

        // one line per destination queue for the whole pass, with a count
        assert.equal(lines.length, 2);

        const own = lines.find(one => one.includes(`queue ${name}`));
        const foreign = lines.find(one => one.includes('queue OtherQueue'));

        assert.match(own || '', /re-queued 2 messages/);
        assert.match(foreign || '', /re-queued 1 messages/);

        for (const line of lines) {
            assert.equal(line.includes('SECRET-MESSAGE-BODY'), false);
            assert.equal(line.includes('-lease'), false);
            assert.equal(line.includes(':worker:'), false);
            assert.equal(line.includes('imq:'), false);
        }
    });

    it('still reports requeues done before a move of the pass throws', async t => {
        const cap = capturing();
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: cap.logger,
            safeDelivery: true,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        const expired = (worker: string) =>
            `imq:${name}:worker:${worker}:${Date.now() - 60000}`;
        const first = expired('abc');
        const second = expired('def');

        QS()[first] = ['MSG'];

        let calls = 0;

        mock.method(rq.writer, 'lmove', (key: string) => {
            if (++calls === 2) {
                return Promise.reject(new Error('LOADING redis is loading'));
            }

            return Promise.resolve(QS()[key]?.pop() || null);
        });

        await assert.rejects(
            rq.processKeys([first, second], Date.now()),
            /LOADING/,
            'the exception must keep escaping exactly as before',
        );

        const lines = matching(cap.warn, /re-queued/);

        assert.equal(
            lines.length,
            1,
            'the requeue which did happen must stay reported',
        );
        assert.match(lines[0], /re-queued 1 messages/);
    });

    it('says unknown instead of leaking a prefix which carries a colon', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue('LeaseColon', {
            logger: cap.logger,
            prefix: 'tenant:prod',
            safeDelivery: true,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        // with such a prefix the two-segment arithmetic reconstructs the
        // move target as the bare prefix, so the exact-prefix strip fails
        const expired = `tenant:prod:LeaseColon:worker:abc:${
            Date.now() - 60000
        }`;

        QS()[expired] = ['MSG'];

        await rq.processKeys([expired], Date.now());

        const lines = matching(cap.warn, /re-queued/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /to queue unknown/);
        assert.equal(lines[0].includes('tenant:prod'), false);
    });

    it('stays quiet when nothing was re-queued', async t => {
        const cap = capturing();
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: cap.logger,
            safeDelivery: true,
        });

        await rq.start();
        t.after(() => rq.destroy(true).catch(() => undefined));

        const fresh = `imq:${name}:worker:abc:${Date.now() + 60000}`;

        QS()[fresh] = ['MSG'];

        await rq.processKeys([fresh], Date.now());

        assert.equal(matching(cap.warn, /re-queued/).length, 0);
    });
});

describe('RedisQueue cleanup deletion logging', () => {
    afterEach(() => mock.restoreAll());

    it('warns with counts only when keys were really removed', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'CleanLogged',
            { logger: cap.logger, cleanup: true, cleanupFilter: '*' },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        const client = 'imq:GoneLogged:writer:pid:1:host:h';

        QS()['imq:GoneLogged'] = ['pending'];
        CL()[client] = true;
        mock.method(rq.writer, 'scan', async () => ['0', ['imq:GoneLogged']]);

        await rq.processCleanup();

        assert.equal(matching(cap.warn, /cleanup removed/).length, 0);

        delete CL()[client];

        await rq.processCleanup();

        assert.equal(matching(cap.warn, /cleanup removed/).length, 0);

        await rq.processCleanup();

        const lines = matching(cap.warn, /cleanup removed/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /removed 1 of 1 candidate keys/);
        assert.equal(lines[0].includes('GoneLogged'), false);
    });
});

describe('RedisQueue publish visibility', () => {
    afterEach(() => mock.restoreAll());

    it('warns once when redis reports no subscribers', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubNoSubs',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq.writer, 'publish', () => 0);

        await rq.publish({ ssn: '000-00-0000' });
        await rq.publish({ ssn: '000-00-0000' });

        const lines = matching(cap.warn, /no subscribers/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /PubNoSubs/);
        assert.equal(lines[0].includes('000-00-0000'), false);
    });

    it('keeps the state of every channel apart', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubTwoChannels',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq.writer, 'publish', () => 0);

        await rq.publish({ a: 1 }, 'ChannelA');
        await rq.publish({ a: 1 }, 'ChannelB');
        await rq.publish({ a: 1 }, 'ChannelA');
        await rq.publish({ a: 1 }, 'ChannelB');

        assert.equal(matching(cap.warn, /no subscribers/).length, 2);
    });

    it('keeps the transition state bounded, reporting the rest every time', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubBounded',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq.writer, 'publish', () => 0);

        for (let i = 0; i < 130; i++) {
            await rq.publish({ a: 1 }, `Channel-${i}`);
        }

        assert.equal(
            rq.noSubscribers.size,
            128,
            'channel names above the bound must not be remembered',
        );

        const before = matching(cap.warn, /no subscribers/).length;

        // a channel above the bound is not remembered, so its publishes
        // keep being reported - the price of a memory-bounded set
        await rq.publish({ a: 1 }, 'Channel-129');
        await rq.publish({ a: 1 }, 'Channel-129');

        assert.equal(matching(cap.warn, /no subscribers/).length, before + 2);
    });

    it('stays quiet when the reply is not a number', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubNoNumber',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq.writer, 'publish', () => undefined);

        await rq.publish({ a: 1 });

        assert.equal(matching(cap.warn, /no subscribers/).length, 0);
    });

    it('does not reject when the reply resists being read', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubEvilReply',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));
        mock.method(rq.writer, 'publish', () => ({
            [Symbol.toPrimitive]() {
                throw new Error('not your business');
            },
        }));

        await assert.doesNotReject(rq.publish({ a: 1 }));
        assert.equal(matching(cap.warn, /no subscribers/).length, 0);
    });

    it('stays quiet while redis reports subscribers', async t => {
        const cap = capturing();
        const rq: any = new RedisQueue(
            'PubWithSubs',
            { logger: cap.logger },
            IMQMode.PUBLISHER,
        );

        await rq.start();
        t.after(() => rq.destroy().catch(() => undefined));

        await rq.publish({ a: 1 });

        assert.equal(matching(cap.warn, /no subscribers/).length, 0);
    });
});
