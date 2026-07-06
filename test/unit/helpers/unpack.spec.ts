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
import { pack, unpack } from '../../../src/helpers';

describe('unpack()', () => {
    it('should reverse pack() for objects', () => {
        const data = { id: '1', message: { hello: 'world' }, from: 'q' };

        assert.deepEqual(unpack(pack(data)), data);
    });

    it('should round-trip every JSON value type', () => {
        const values: unknown[] = [
            null,
            true,
            false,
            0,
            -12.34,
            'string',
            [],
            [1, 'two', false, null],
            { a: { b: { c: [1, 2, 3] } } },
        ];

        for (const value of values) {
            assert.deepEqual(unpack(pack(value)), value);
        }
    });

    it('should preserve unicode content', () => {
        const data = { text: 'Привіт 🌍 — çà va?' };

        assert.deepEqual(unpack(pack(data)), data);
    });

    it('should preserve nested arrays and objects deeply', () => {
        const data = {
            level1: { level2: { level3: [{ x: 1 }, { y: [true, null] }] } },
        };

        assert.deepEqual(unpack(pack(data)), data);
    });
});
