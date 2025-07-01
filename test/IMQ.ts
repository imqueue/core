/*!
 * IMessageQueue Unit Tests
 *
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
 */
import './mocks';
import { expect } from 'chai';
import IMQ, { RedisQueue, ClusteredRedisQueue } from '..';

describe('IMQ', () => {

    it('should be a class', () => {
        expect(typeof IMQ).to.equal('function');
    });

    describe('create()', () => {
        it('should return proper object', () => {
            expect(IMQ.create('IMQUnitTest', { vendor: 'Redis' }))
                .instanceof(RedisQueue);
        });

        it('should throw if unknown vendor specified', () => {
            expect(() => IMQ.create('IMQUnitTest', { vendor: 'JudgmentDay' }))
                .to.throw(Error);
        });

        it('should allow to be called with no options', () => {
            expect(() => IMQ.create('IMQUnitTest'))
                .not.to.throw(Error);
        });

        it('should return clustered object if cluster options passed', () => {
            expect(IMQ.create('IMQUnitTest', {
                vendor: 'Redis',
                cluster: [{
                    host: 'localhost',
                    port: 1111
                }, {
                    host: 'localhost',
                    port: 2222
                }]
            })).instanceof(ClusteredRedisQueue);
        });
    });

});
