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
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envInt } from '../../../src/helpers/index.js';

const VAR = 'IMQ_ENV_INT_TEST';

describe('envInt()', () => {
    afterEach(() => {
        delete process.env[VAR];
    });

    it('should read an integer value from the environment', () => {
        process.env[VAR] = '4242';

        assert.equal(envInt(VAR, 1), 4242);
    });

    it('should fall back to the default when the variable is unset', () => {
        assert.equal(envInt(VAR, 555), 555);
    });

    it('should fall back to the default for non-numeric values', () => {
        process.env[VAR] = 'not-a-number';

        assert.equal(envInt(VAR, 7), 7);
    });

    it('should read a zero value set explicitly', () => {
        process.env[VAR] = '0';

        assert.equal(envInt(VAR, 99), 0);
    });

    it('should parse negative integers', () => {
        process.env[VAR] = '-15';

        assert.equal(envInt(VAR, 0), -15);
    });
});
