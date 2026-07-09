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
import { sha1 } from '../../../src/helpers/index.js';

describe('sha1()', () => {
    it('should return a 40-character lowercase hex string', () => {
        const hash = sha1('imqueue');

        assert.match(hash, /^[0-9a-f]{40}$/);
    });

    it('should match known SHA-1 test vectors', () => {
        assert.equal(sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
        assert.equal(sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    });

    it('should be deterministic for equal input', () => {
        assert.equal(sha1('same'), sha1('same'));
    });

    it('should produce different hashes for different input', () => {
        assert.notEqual(sha1('a'), sha1('b'));
    });
});
