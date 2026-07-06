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
import { escapeRegExp } from '../../../src/helpers';

describe('escapeRegExp()', () => {
    it('should leave plain alphanumeric strings unchanged', () => {
        assert.equal(escapeRegExp('imq123'), 'imq123');
    });

    it('should escape every regexp special character', () => {
        assert.equal(
            escapeRegExp('.*+?^${}()|[]\\'),
            '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\',
        );
    });

    it('should produce a pattern that matches the literal input', () => {
        const literal = 'a.b*c(d)';
        const rx = new RegExp(`^${escapeRegExp(literal)}$`);

        assert.ok(rx.test(literal));
    });

    it('should prevent metacharacters from matching non-literally', () => {
        const rx = new RegExp(`^${escapeRegExp('a.c')}$`);

        assert.ok(rx.test('a.c'));
        assert.ok(!rx.test('axc'));
    });

    it('should return an empty string unchanged', () => {
        assert.equal(escapeRegExp(''), '');
    });
});
