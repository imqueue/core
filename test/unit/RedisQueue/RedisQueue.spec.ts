/*!
 * RedisQueue Unit Tests
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
import { logger } from '../../mocks';
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue, uuid, IMQMode } from '../../../src';
import Redis from 'ioredis';

process.setMaxListeners(100);

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
            } catch (err) {
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

        it('should trigger an error in case of redis error', (t, done) => {
            const lrange = Redis.prototype.lrange;
            let wasDone = false;
            Redis.prototype.lrange = async (): Promise<string[]> =>
                [undefined, undefined] as unknown as string[];

            const message: any = { hello: 'safe delivery' };
            const rq = new RedisQueue('IMQSafe', {
                logger,
                safeDelivery: true,
            });

            rq.on('error', function (e) {
                assert.equal((e as any).message, 'Wrong messages count');
                Redis.prototype.lrange = lrange;
                if (!wasDone) {
                    rq.destroy().catch();
                    done();
                }
                wasDone = true;
            });

            rq.start().then(() => rq.send('IMQSafe', message));
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
