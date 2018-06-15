/*!
 * IMessageQueue Unit Tests
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
import './mocks';
import { expect } from 'chai';
import IMQ, { RedisQueue, ClusteredRedisQueue } from '..';

describe('IMQ', () => {

    it('should be a class', () => {
        expect(typeof IMQ).to.equal('function');
    });

    describe('create()', () => {
        it('should return proper object', () => {
            expect(IMQ.create('IMQUnitTest', { vendor: 'Redis' }))
                .instanceof(RedisQueue);
        });

        it('should throw if unknown vendor specified', () => {
            expect(() => IMQ.create('IMQUnitTest', { vendor: 'JudgmentDay' }))
                .to.throw(Error);
        });

        it('should allow to be called with no options', () => {
            expect(() => IMQ.create('IMQUnitTest'))
                .not.to.throw(Error);
        });

        it('should return clustered object if cluster options passed', () => {
            expect(IMQ.create('IMQUnitTest', {
                vendor: 'Redis',
                cluster: [{
                    host: 'localhost',
                    port: 1111
                }, {
                    host: 'localhost',
                    port: 2222
                }]
            })).instanceof(ClusteredRedisQueue);
        });
    });

});
