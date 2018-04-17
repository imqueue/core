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
import { ClusteredRedisQueue } from '../src';

process.setMaxListeners(100);

const clusterConfig = {
    cluster: [{
        host: '127.0.0.1',
        port: 6380
    }, {
        host: '127.0.0.1',
        port: 6381
    }]
};

describe('ClusteredRedisQueue', function() {
    this.timeout(30000);

    it('should be a class', () => {
        expect(typeof ClusteredRedisQueue).to.equal('function');
    });

    it('should implement IMessageQueue interface', () => {
        // expect(typeof ClusteredRedisQueue.prototype.start)
        //     .to.equal('function');
        // expect(typeof ClusteredRedisQueue.prototype.stop)
        //     .to.equal('function');
        // expect(typeof ClusteredRedisQueue.prototype.send)
        //     .to.equal('function');
        // expect(typeof ClusteredRedisQueue.prototype.destroy)
        //     .to.equal('function');
    });

    describe('constructor()', () => {

    });

    describe('start()', () => {

    });

    describe('stop()', () => {

    });

    describe('send()', () => {

    });

    describe('destroy()', () => {

    });

    describe('clear()', () => {

    });

});
