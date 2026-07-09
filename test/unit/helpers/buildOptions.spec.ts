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
import { buildOptions } from '../../../src/helpers/index.js';

interface Options {
    host: string;
    port: number;
    verbose?: boolean;
}

describe('buildOptions()', () => {
    const defaults: Options = { host: 'localhost', port: 6379 };

    it('should return defaults when no options are given', () => {
        assert.deepEqual(buildOptions(defaults), defaults);
    });

    it('should override defaults with given values', () => {
        const result = buildOptions(defaults, { port: 7000, verbose: true });

        assert.deepEqual(result, {
            host: 'localhost',
            port: 7000,
            verbose: true,
        });
    });

    it('should not mutate the defaults object', () => {
        buildOptions(defaults, { port: 9999 });

        assert.equal(defaults.port, 6379);
    });

    it('should return a new object instance', () => {
        assert.notEqual(buildOptions(defaults), defaults);
    });

    it('should apply a partial override without dropping other defaults', () => {
        const result = buildOptions(defaults, { host: 'redis.local' });

        assert.equal(result.host, 'redis.local');
        assert.equal(result.port, 6379);
    });
});
