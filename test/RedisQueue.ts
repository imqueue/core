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
import { logger } from './mocks';
import { expect } from 'chai';
import { RedisQueue, uuid } from '../src';
import Redis from 'ioredis';

process.setMaxListeners(100);

describe('RedisQueue', function() {
    this.timeout(30000);

    it('should be a class', () => {
        expect(typeof RedisQueue).to.equal('function');
    });

    it('should implement IMessageQueue interface', () => {
        expect(typeof RedisQueue.prototype.start).to.equal('function');
        expect(typeof RedisQueue.prototype.stop).to.equal('function');
        expect(typeof RedisQueue.prototype.send).to.equal('function');
        expect(typeof RedisQueue.prototype.destroy).to.equal('function');
    });

    describe('constructor()', () => {
        it('should not throw', () => {
            expect(() => new (<any>RedisQueue)()).not.to.throw(Error);
            expect(() => new RedisQueue('IMQUnitTests')).not.to.throw(Error);
            expect(() => new RedisQueue('IMQUnitTests', {}))
                .not.to.throw(Error);
            expect(() => new RedisQueue('IMQUnitTests', { useGzip: true }))
                .not.to.throw(Error);
        });
    });

    describe('start()', () => {
        it('should throw if no name provided', async () => {
            const rq = new (<any>RedisQueue)();
            try { await rq.start() }
            catch (err) { expect(err).to.be.instanceof(TypeError) }
        });

        it('should create reader connection', async () => {
            try {
                const rq: any = new RedisQueue(uuid(), { logger });
                await rq.start();
                expect(rq.reader).to.be.instanceof(Redis);
                await rq.destroy();
            }

            catch (err) { console.error(err) }
        });

        it('should create shared writer connection', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            expect(rq.writer).to.be.instanceof(Redis);
            await rq.destroy();
        });

        it('should create single watcher connection', async () => {
            const rq1: any = new RedisQueue(uuid(), { logger });
            const rq2: any = new RedisQueue(uuid(), { logger });
            await rq1.start();
            await rq2.start();
            expect(await rq1.watcherCount()).to.be.equal(1);
            expect(await rq2.watcherCount()).to.be.equal(1);
            await rq1.destroy();
            await rq2.destroy();
        });

        it('should restart stopped queue', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            await rq.stop();
            await rq.start();
            expect(rq.reader).to.be.instanceof(Redis);
            await rq.destroy();
        });

        it('should not fail on double start', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            let passed = true;
            try {
                await rq.start();
                await rq.start();
            } catch (err) { passed = false }
            expect(passed).to.be.true;
            rq.destroy().catch();
        });
    });

    describe('stop()', () => {
        it('should stop reading messages from queue', async () => {
            const name = uuid();
            const rq: any =  new RedisQueue(name, { logger });
            await rq.start();
            expect(rq.reader).to.be.instanceof(Redis);
            await rq.stop();
            expect(rq.reader).not.to.be.ok;
            await rq.destroy();
        });
    });

    describe('send()', () => {
        it('should send given message to a given queue', (done) => {
            const message: any = { hello: 'world' };
            const rqFrom = new RedisQueue('IMQUnitTestsFrom', { logger });
            const rqTo = new RedisQueue('IMQUnitTestsTo', { logger });

            rqTo.on('message', (msg, id, from) => {
                expect(msg).to.deep.equal(message);
                expect(id).not.to.be.undefined;
                expect(from).to.equal('IMQUnitTestsFrom');
                rqFrom.destroy().catch();
                rqTo.destroy().catch();
                done();
            });

            rqFrom.start().then(() => { rqTo.start().then(() => {
                rqFrom.send('IMQUnitTestsTo', message).catch();
            });});
        });

        it('should guaranty message delivery if safeDelivery is on', (done) => {
            // it is hard to emulate mq crash at a certain time of
            // its runtime execution, so we simply assume delivery works itself
            // for the moment. dumb test but better than nothing :(
            const message: any = { hello: 'safe delivery' };
            const rq = new RedisQueue('IMQSafe', {
                logger, safeDelivery: true,
            });

            rq.on('message', (msg) => {
                expect(msg).to.deep.equal(message);
                rq.destroy().catch();
                done();
            });

            rq.start().then(async () => rq.send('IMQSafe', message));
        });

        it('should deliver message with the given delay', (done) => {
            const message: any = { hello: 'world' };
            const delay: number = 1000;
            const rqFrom = new RedisQueue('IMQUnitTestsFromD', { logger });
            const rqTo = new RedisQueue('IMQUnitTestsToD', { logger });

            let start: number;

            rqTo.on('message', (msg, id, from) => {
                expect(Date.now() - start).to.be.gte(delay);
                expect(msg).to.deep.equal(message);
                expect(id).not.to.be.undefined;
                expect(from).to.equal('IMQUnitTestsFromD');
                rqFrom.destroy().catch();
                rqTo.destroy().catch();
                done();
            });

            rqFrom.start().then(() => { rqTo.start().then(() => {
                start = Date.now();
                rqFrom.send('IMQUnitTestsToD', message, delay).catch();
            });});
        });

        it('should trigger an error in case of redis error', (done) => {
            const lrange = Redis.prototype.lrange;
            let wasDone = false;
            Redis.prototype.lrange = async (): Promise<string[]> =>
                [undefined, undefined] as unknown as string[];

            const message: any = { hello: 'safe delivery' };
            const rq = new RedisQueue('IMQSafe', {
                logger, safeDelivery: true
            });

            process.on('unhandledRejection', function(e) {
                expect((e as any).message).to.be.equal('Wrong messages count');
                Redis.prototype.lrange = lrange;
                !wasDone && done();
                wasDone = true;
            });

            rq.start().then(() => rq.send('IMQSafe', message));
        });
    });

    describe('destroy()', () => {
        let rq: any;

        beforeEach(async () => {
            rq =  new RedisQueue(uuid(), { logger });
            await rq.start();
        });

        it('should destroy all connections', async () => {
            await rq.destroy();
            expect(rq.watcher).not.to.be.ok;
            expect(rq.reader).not.to.be.ok;
            expect(rq.writer).not.to.be.ok;
        });

        it('should remove all event listeners', async () => {
            await rq.destroy();
            expect(rq.listenerCount()).to.equal(0);
        });
    });

    describe('clear()', () => {
        it('should clean-up queue data in redis', async () => {
            const rq: any =  new RedisQueue(uuid(), { logger });
            await rq.start();
            rq.clear();
            expect(await rq.writer.exists(rq.key))
                .not.to.be.ok;
            expect(await rq.writer.exists(`${rq.key}:delayed`))
                .not.to.be.ok;
            rq.destroy().catch();
        });
    });

});
