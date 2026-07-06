/*!
 * IMessageQueue Unit Tests
 *
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
import '../mocks';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import IMQ, { RedisQueue, ClusteredRedisQueue } from '../..';

describe('IMQ', () => {
    it('should be a class', () => {
        assert.equal(typeof IMQ, 'function');
    });

    describe('create()', () => {
        it('should return proper object', () => {
            assert.ok(
                IMQ.create('IMQUnitTest', { vendor: 'Redis' }) instanceof
                    RedisQueue,
            );
        });

        it('should throw if unknown vendor specified', () => {
            assert.throws(
                () => IMQ.create('IMQUnitTest', { vendor: 'JudgmentDay' }),
                Error,
            );
        });

        it('should allow to be called with no options', () => {
            assert.doesNotThrow(() => IMQ.create('IMQUnitTest'));
        });

        it('should return clustered object if cluster options passed', () => {
            assert.ok(
                IMQ.create('IMQUnitTest', {
                    vendor: 'Redis',
                    cluster: [
                        {
                            host: 'localhost',
                            port: 1111,
                        },
                        {
                            host: 'localhost',
                            port: 2222,
                        },
                    ],
                }) instanceof ClusteredRedisQueue,
            );
        });
    });
});
