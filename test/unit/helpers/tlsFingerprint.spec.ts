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
import { tlsFingerprint } from '../../../src/helpers/index.js';

const CA_ONE = Buffer.from('-----BEGIN CERTIFICATE-----\nONE\n');
const CA_TWO = Buffer.from('-----BEGIN CERTIFICATE-----\nTWO\n');

describe('tlsFingerprint()', () => {
    it('should treat `true` as an empty configuration', () => {
        // `tls: true` and `tls: {}` mean the same thing to ioredis, so two
        // queues written either way must land in the same pool slot
        assert.equal(tlsFingerprint(true), tlsFingerprint({}));
    });

    it('should be stable across independently built literals', () => {
        assert.equal(
            tlsFingerprint({ ca: CA_ONE, servername: 'redis.internal' }),
            tlsFingerprint({
                ca: Buffer.from(CA_ONE),
                servername: 'redis.internal',
            }),
        );
    });

    it('should not depend on key order', () => {
        assert.equal(
            tlsFingerprint({ servername: 'a', rejectUnauthorized: true }),
            tlsFingerprint({ rejectUnauthorized: true, servername: 'a' }),
        );
    });

    it('should ignore keys explicitly set to undefined', () => {
        assert.equal(
            tlsFingerprint({ ca: CA_ONE }),
            tlsFingerprint({ ca: CA_ONE, servername: undefined }),
        );
    });

    it('should distinguish different trust anchors', () => {
        assert.notEqual(
            tlsFingerprint({ ca: CA_ONE }),
            tlsFingerprint({ ca: CA_TWO }),
        );
    });

    it('should distinguish a plain-text anchor from a binary one', () => {
        assert.notEqual(
            tlsFingerprint({ ca: CA_ONE.toString() }),
            tlsFingerprint({ ca: CA_ONE }),
        );
    });

    it('should distinguish an added client certificate', () => {
        assert.notEqual(
            tlsFingerprint({ ca: CA_ONE }),
            tlsFingerprint({ ca: CA_ONE, cert: CA_TWO, key: CA_TWO }),
        );
    });

    it('should distinguish disabled verification', () => {
        assert.notEqual(
            tlsFingerprint({ ca: CA_ONE }),
            tlsFingerprint({ ca: CA_ONE, rejectUnauthorized: false }),
        );
    });

    it('should distinguish different expected server names', () => {
        assert.notEqual(
            tlsFingerprint({ servername: 'redis-a.internal' }),
            tlsFingerprint({ servername: 'redis-b.internal' }),
        );
    });

    it('should compare arrays of anchors element by element', () => {
        assert.equal(
            tlsFingerprint({ ca: [CA_ONE, CA_TWO] }),
            tlsFingerprint({ ca: [Buffer.from(CA_ONE), CA_TWO] }),
        );
        assert.notEqual(
            tlsFingerprint({ ca: [CA_ONE, CA_TWO] }),
            tlsFingerprint({ ca: [CA_TWO, CA_ONE] }),
        );
    });

    it('should distinguish different verification callbacks', () => {
        assert.notEqual(
            tlsFingerprint({ checkServerIdentity: () => undefined }),
            tlsFingerprint({
                checkServerIdentity: () => new Error('nope'),
            }),
        );
    });

    it('should treat an identical callback as identical', () => {
        const check = (): undefined => undefined;

        assert.equal(
            tlsFingerprint({ checkServerIdentity: check }),
            tlsFingerprint({ checkServerIdentity: check }),
        );
    });

    it('should render an opaque host object by its type', () => {
        // a prebuilt SecureContext has no readable structure, so two distinct
        // instances of one class are indistinguishable here - a documented
        // limit of the fingerprint, not an accident
        class SecureContext {}

        assert.equal(
            tlsFingerprint({ secureContext: new SecureContext() } as any),
            tlsFingerprint({ secureContext: new SecureContext() } as any),
        );
        assert.notEqual(
            tlsFingerprint({ secureContext: new SecureContext() } as any),
            tlsFingerprint({}),
        );
    });

    it('should tolerate an undefined element inside an array', () => {
        assert.notEqual(
            tlsFingerprint({ ca: [CA_ONE, undefined] } as any),
            tlsFingerprint({ ca: [CA_ONE] } as any),
        );
    });

    it('should read a raw ArrayBuffer as its bytes', () => {
        const buffer = new ArrayBuffer(4);

        new Uint8Array(buffer).set([1, 2, 3, 4]);

        assert.equal(
            tlsFingerprint({ ca: buffer } as any),
            tlsFingerprint({ ca: Buffer.from([1, 2, 3, 4]) } as any),
        );
    });

    it('should tolerate a null option value', () => {
        assert.equal(typeof tlsFingerprint({ ca: null } as any), 'string');
    });
});
