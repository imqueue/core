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
import { gunzipSync } from 'node:zlib';
import { pack } from '../../../src/helpers';

describe('pack()', () => {
    it('should return a string', () => {
        assert.equal(typeof pack({ hello: 'world' }), 'string');
    });

    it('should produce output that gunzips back to the source JSON', () => {
        const data = { a: 1, b: [true, null, 'x'], c: { nested: 'value' } };
        const packed = pack(data);
        const restored = gunzipSync(Buffer.from(packed, 'binary')).toString();

        assert.equal(restored, JSON.stringify(data));
    });

    it('should be deterministic for equal input', () => {
        const data = { list: [1, 2, 3], flag: false };

        assert.equal(pack(data), pack(data));
    });

    it('should compress large repetitive payloads below raw JSON size', () => {
        const data = { items: Array.from({ length: 1000 }, () => 'repeat') };
        const packed = pack(data);

        assert.ok(packed.length < JSON.stringify(data).length);
    });

    it('should handle primitive and null values', () => {
        assert.equal(
            gunzipSync(Buffer.from(pack(null), 'binary')).toString(),
            'null',
        );
        assert.equal(
            gunzipSync(Buffer.from(pack(42), 'binary')).toString(),
            '42',
        );
    });
});
