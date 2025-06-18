/*!
 * uuid() Function Unit Tests
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


import { EventEmitter } from 'events';
import { expect } from 'chai';
import { copyEventEmitter } from '../src';

describe('copyEventEmitter()', function() {
    const eventName = 'test';

    it('should have the same number of listeners', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.on('test', () => {});
        copyEventEmitter(source, target);

        expect(target.listenerCount('test')).to.be.equal(1);
    });

    it('should copy the same listener on', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.on(eventName, () => {});

        copyEventEmitter(source, target);

        const targetListener = target.listeners(eventName)[0];
        const sourceListener = source.listeners(eventName)[0];

        expect(targetListener).to.be.equal(sourceListener);
    });

    it('should copy the same listener once', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.once(eventName, () => {});
        copyEventEmitter(source, target);

        const targetListener = target.listeners(eventName)[0];
        const sourceListener = source.listeners(eventName)[0];

        expect(targetListener).to.be.equal(sourceListener);
    });

    it('should set same max listeners count', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.setMaxListeners(25);
        copyEventEmitter(source, target);

        const targetListenersCount = target.getMaxListeners();
        const sourceListenersCount = source.getMaxListeners();

        expect(targetListenersCount).to.be.equal(sourceListenersCount);
    });
});
