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
import { errorCode } from '../../../src/helpers/index.js';

describe('errorCode()', () => {
    it('prefers an explicit string code', () => {
        assert.equal(
            errorCode(
                Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }),
            ),
            'ECONNREFUSED',
        );
    });

    it('accepts a numeric code', () => {
        assert.equal(errorCode({ code: 42 }), '42');
    });

    it('reads the leading redis reply code', () => {
        assert.equal(
            errorCode(new Error('WRONGTYPE Operation against a key')),
            'WRONGTYPE',
        );
    });

    it('accepts a framework code', () => {
        assert.equal(
            errorCode({ code: 'IMQ_RPC_CALL_TIMEOUT' }),
            'IMQ_RPC_CALL_TIMEOUT',
        );
    });

    it('maps a known client failure message to a code', () => {
        assert.equal(
            errorCode(new Error('Connection is closed.')),
            'CONNECTION_CLOSED',
        );
        assert.equal(
            errorCode(new Error('Stream connection ended by server')),
            'STREAM_ENDED',
        );
    });

    it('never returns the message itself', () => {
        assert.equal(
            errorCode(new Error('user 12345 phone +100000000')),
            'unknown',
        );
    });

    it('never returns an upper-case word of an unknown message', () => {
        assert.equal(errorCode(new Error('CUSTOMER 12345 secret')), 'unknown');
    });

    it('never returns a code outside the allow-list', () => {
        assert.equal(errorCode({ code: 'SSN-000-00-0000' }), 'unknown');
        assert.equal(
            errorCode({ code: 'CUSTOMER_12345_NOT_FOUND' }),
            'unknown',
        );
        assert.equal(errorCode({ code: 123456789 }), 'unknown');
        assert.equal(errorCode({ code: -1 }), 'unknown');
        assert.equal(errorCode({ code: 1.5 }), 'unknown');
    });

    it('never returns the error class name', () => {
        assert.equal(errorCode(new TypeError('boom')), 'unknown');
        assert.equal(errorCode({ name: 'Customer_12345' }), 'unknown');
    });

    it('never throws on odd values', () => {
        assert.equal(errorCode(undefined), 'unknown');
        assert.equal(errorCode(null), 'unknown');
        assert.equal(errorCode('a string'), 'unknown');
        assert.equal(errorCode(0), 'unknown');
        assert.equal(errorCode({}), 'unknown');
    });

    it('never throws when reading a property throws', () => {
        const evil = {
            get code(): string {
                throw new Error('nope');
            },
        };

        assert.equal(errorCode(evil), 'unknown');
    });
});
