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
import { expect } from 'chai';
import { EventEmitter as IMQEventEmitter } from '../src';
import { EventEmitter as NodeEventEmitter } from 'events';

// This test ensures the re-exported EventEmitter from IMessageQueue.ts is exercised
// to cover the function counted by nyc/istanbul for that re-export.
describe('IMessageQueue EventEmitter re-export', () => {
    it('should re-export Node.js EventEmitter and be usable', () => {
        // Ensure it is the same constructor
        expect(IMQEventEmitter).to.equal(NodeEventEmitter);

        // And it works as expected when instantiated
        const ee = new IMQEventEmitter();
        let called = 0;
        ee.on('ping', () => { called++; });
        ee.emit('ping');
        expect(called).to.equal(1);
    });
});
