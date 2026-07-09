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
import '../../mocks/index.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// the default import of a builtin is the live, mutable CommonJS module
// object (unlike `import * as`, whose namespace is frozen), so patching
// util.inspect below works; syncBuiltinESMExports() then publishes the
// patch to the named-import binding the code under test reads
import util from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { copyEventEmitter } from '../../../src/helpers/index.js';

describe('copyEventEmitter()', () => {
    const eventName = 'test';

    it('should have the same number of listeners', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.on('test', () => {});
        copyEventEmitter(source, target);

        assert.equal(target.listenerCount('test'), 1);
    });

    it('should copy the same listener on', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.on(eventName, () => {});

        copyEventEmitter(source, target);

        const targetListener = target.listeners(eventName)[0];
        const sourceListener = source.listeners(eventName)[0];

        assert.equal(targetListener, sourceListener);
    });

    it('should copy the same listener once', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.once(eventName, () => {});
        copyEventEmitter(source, target);

        const targetListener = target.listeners(eventName)[0];
        const sourceListener = source.listeners(eventName)[0];

        assert.equal(targetListener, sourceListener);
    });

    it('should set same max listeners count', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        source.setMaxListeners(25);
        copyEventEmitter(source, target);

        const targetListenersCount = target.getMaxListeners();
        const sourceListenersCount = source.getMaxListeners();

        assert.equal(targetListenersCount, sourceListenersCount);
    });

    it('should handle listeners without listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Create a mock listener that looks like onceWrapper but has no listener property
        const mockListener = function () {};
        Object.defineProperty(mockListener, 'toString', {
            value: () => 'function onceWrapper() { ... }',
        });

        // Manually add the listener to simulate the edge case
        source.on(eventName, mockListener);

        // Mock util.inspect to return onceWrapper for this listener
        const originalInspect = util.inspect;
        (util as any).inspect = (obj: any) => {
            if (obj === mockListener) {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };
        syncBuiltinESMExports();

        copyEventEmitter(source, target);

        // Restore original inspect
        (util as any).inspect = originalInspect;
        syncBuiltinESMExports();

        assert.equal(target.listenerCount(eventName), 1);
    });

    it('should handle source without _maxListeners property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Remove _maxListeners property to test the undefined case
        delete (source as any)._maxListeners;

        source.on(eventName, () => {});
        copyEventEmitter(source, target);

        assert.equal(target.listenerCount(eventName), 1);
    });

    it('should handle once listeners with listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        const originalListener = () => {};
        source.once(eventName, originalListener);

        copyEventEmitter(source, target);

        assert.equal(target.listenerCount(eventName), 1);
    });
    it('should handle onceWrapper-like listener with falsy listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Create a mock listener that looks like onceWrapper and has a falsy listener property
        const mockListener: any = function () {};
        mockListener.listener = 0; // falsy value present
        const originalInspect = util.inspect;
        (util as any).inspect = (obj: any) => {
            if (obj === mockListener) {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };
        syncBuiltinESMExports();

        source.on(eventName, mockListener as any);
        copyEventEmitter(source, target);

        // Restore original inspect
        (util as any).inspect = originalInspect;
        syncBuiltinESMExports();

        assert.equal(target.listenerCount(eventName), 1);
    });

    it('should handle onceWrapper-like listener with undefined listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        const mockListener: any = function () {};
        mockListener.listener = undefined; // explicitly undefined
        const originalInspect = util.inspect;
        (util as any).inspect = (obj: any) => {
            if (obj === mockListener) {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };
        syncBuiltinESMExports();

        source.on(eventName, mockListener as any);
        copyEventEmitter(source, target);

        // Restore original inspect
        (util as any).inspect = originalInspect;
        syncBuiltinESMExports();

        assert.equal(target.listenerCount(eventName), 1);
    });

    it('should handle onceWrapper-like listener with truthy listener property', () => {
        const source = new EventEmitter();
        const target = new EventEmitter();

        // Create a mock listener that looks like onceWrapper and has a truthy listener property
        let called = 0;
        const realListener = () => {
            called++;
        };
        const mockListener: any = function () {};
        mockListener.listener = realListener; // truthy function

        const originalInspect = util.inspect;
        (util as any).inspect = (obj: any) => {
            if (obj === mockListener) {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };
        syncBuiltinESMExports();

        source.on(eventName, mockListener as any);
        copyEventEmitter(source, target);

        // Restore original inspect
        (util as any).inspect = originalInspect;
        syncBuiltinESMExports();

        // Ensure the listener was attached via once() and is callable exactly once
        assert.equal(target.listenerCount(eventName), 1);
        target.emit(eventName);
        target.emit(eventName);
        assert.equal(called, 1);
    });

    it('should handle onceWrapper path when originalListener is undefined', () => {
        const source: any = {
            eventNames: () => [eventName],
            rawListeners: () => [undefined],
            getMaxListeners: () => 0,
            setMaxListeners: () => {},
        };
        const onceCalls: any[] = [];
        const target: any = {
            once: (ev: any, listener: any) => {
                onceCalls.push([ev, listener]);
            },
            on: () => {},
        };
        const originalInspect = util.inspect;
        (util as any).inspect = (obj: any) => {
            if (typeof obj === 'undefined') {
                return 'function onceWrapper() { ... }';
            }
            return originalInspect(obj);
        };
        syncBuiltinESMExports();

        copyEventEmitter(source as any, target as any);

        // Restore original inspect
        (util as any).inspect = originalInspect;
        syncBuiltinESMExports();

        assert.equal(onceCalls.length, 1);
        assert.equal(onceCalls[0][0], eventName);
        assert.equal(onceCalls[0][1], undefined);
    });
});
