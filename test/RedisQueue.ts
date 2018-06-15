/*!
 * RedisQueue Unit Tests
 *
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import { logger } from './mocks';
import { expect } from 'chai';
import { RedisQueue, uuid } from '../src';
import * as redis from 'redis';

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
                expect(rq.reader).to.be.instanceof(redis.RedisClient);
                await rq.destroy();
            }

            catch (err) { console.error(err) }
        });

        it('should create shared writer connection', async () => {
            const rq: any = new RedisQueue(uuid(), { logger });
            await rq.start();
            expect(rq.writer).to.be.instanceof(redis.RedisClient);
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
            expect(rq.reader).to.be.instanceof(redis.RedisClient);
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
            expect(rq.reader).to.be.instanceof(redis.RedisClient);
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
                logger, safeDelivery: true
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
