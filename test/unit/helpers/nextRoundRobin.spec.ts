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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundRobin } from '../../../src/helpers/index.js';

describe('nextRoundRobin()', () => {
    const any = (): boolean => true;

    it('returns the item at the cursor when it is accepted', () => {
        assert.equal(nextRoundRobin(['a', 'b', 'c'], 1, any), 1);
    });

    it('skips items the predicate refuses, wrapping around once', () => {
        assert.equal(
            nextRoundRobin(['a', 'b', 'c'], 2, item => item === 'a'),
            0,
        );
    });

    it('takes a cursor past the end modulo the number of items', () => {
        assert.equal(nextRoundRobin(['a', 'b'], 5, any), 1);
    });

    it('returns -1 when no item is accepted, or there are none', () => {
        assert.equal(
            nextRoundRobin(['a', 'b'], 0, () => false),
            -1,
        );
        assert.equal(nextRoundRobin([], 3, any), -1);
    });
});
