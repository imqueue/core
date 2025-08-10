/*!
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
import './mocks';
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

    it('should handle listeners without listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Create a mock listener that looks like onceWrapper but has no listener property
        const mockListener = function() {};
        Object.defineProperty(mockListener, 'toString', {
            value: () => 'function onceWrapper() { ... }'
        });

        // Manually add the listener to simulate the edge case
        source.on(eventName, mockListener);

        // Mock util.inspect to return onceWrapper for this listener
        const originalInspect = require('util').inspect;
        require('util').inspect = (obj: any) => {
            if (obj === mockListener) {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };

        copyEventEmitter(source, target);

        // Restore original inspect
        require('util').inspect = originalInspect;

        expect(target.listenerCount(eventName)).to.be.equal(1);
    });

    it('should handle source without _maxListeners property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Remove _maxListeners property to test the undefined case
        delete (source as any)._maxListeners;

        source.on(eventName, () => {});
        copyEventEmitter(source, target);

        expect(target.listenerCount(eventName)).to.be.equal(1);
    });

    it('should handle once listeners with listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        const originalListener = () => {};
        source.once(eventName, originalListener);

        copyEventEmitter(source, target);

        expect(target.listenerCount(eventName)).to.be.equal(1);
    });
});
