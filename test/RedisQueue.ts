/*!
 * RedisQueue Unit Tests
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
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
import './mocks';
import { expect } from 'chai';
import { RedisQueue } from '../src';

describe('RedisQueue', () => {

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

        });

        it('should create shared writer connection', async () => {

        });

        it('should create single watcher connection', async () => {

        });
    });

    describe('on("message", callback)', () => {
        it('should properly handle message from queue with a given callback', () => {

        })
    });

    describe('stop()', () => {
        it('should stop reading messages from queue', () => {

        });
    });

    describe('send()', () => {
        it('should send given message to a given queue', () => {

        });
    });

    describe('destroy()', () => {
        it('should destroy all connections', () => {

        });

        it('should remove all event listeners', () => {

        });
    });

});
