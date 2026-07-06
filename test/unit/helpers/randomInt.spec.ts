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
import { randomInt } from '../../../src/helpers';

describe('randomInt()', () => {
    it('should always return an integer within the inclusive range', () => {
        for (let i = 0; i < 10000; i++) {
            const value = randomInt(1, 10);

            assert.ok(Number.isInteger(value));
            assert.ok(value >= 1 && value <= 10, `out of range: ${value}`);
        }
    });

    it('should return the bound when min equals max', () => {
        assert.equal(randomInt(7, 7), 7);
    });

    it('should support negative ranges', () => {
        for (let i = 0; i < 1000; i++) {
            const value = randomInt(-5, -1);

            assert.ok(value >= -5 && value <= -1, `out of range: ${value}`);
        }
    });

    it('should be able to hit both range boundaries', () => {
        const seen = new Set<number>();

        for (let i = 0; i < 5000; i++) {
            seen.add(randomInt(0, 1));
        }

        assert.ok(seen.has(0));
        assert.ok(seen.has(1));
    });
});
