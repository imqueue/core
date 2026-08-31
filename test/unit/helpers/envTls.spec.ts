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
import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envTls } from '../../../src/helpers/index.js';

const VARS = [
    'IMQ_REDIS_TLS',
    'IMQ_REDIS_TLS_CA_FILE',
    'IMQ_REDIS_TLS_CERT_FILE',
    'IMQ_REDIS_TLS_KEY_FILE',
    'IMQ_REDIS_TLS_KEY_PASSPHRASE',
    'IMQ_REDIS_TLS_SERVERNAME',
    'IMQ_REDIS_TLS_REJECT_UNAUTHORIZED',
];

let dir: string;
let caFile: string;
let certFile: string;
let keyFile: string;

describe('envTls()', () => {
    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'imq-tls-'));
        caFile = join(dir, 'ca.crt');
        certFile = join(dir, 'client.crt');
        keyFile = join(dir, 'client.key');

        writeFileSync(caFile, 'CA-PEM');
        writeFileSync(certFile, 'CERT-PEM');
        writeFileSync(keyFile, 'KEY-PEM');
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    afterEach(() => {
        for (const name of VARS) {
            delete process.env[name];
        }
    });

    it('should return nothing when the environment is silent', () => {
        assert.equal(envTls(), undefined);
    });

    it('should enable TLS on the switch alone', () => {
        process.env.IMQ_REDIS_TLS = '1';

        assert.deepEqual(envTls(), {});
    });

    it('should accept the usual spellings of on', () => {
        for (const value of ['1', 'true', 'YES', ' on ']) {
            process.env.IMQ_REDIS_TLS = value;

            assert.deepEqual(envTls(), {}, `for ${JSON.stringify(value)}`);
        }
    });

    it('should ignore an unrecognised switch value', () => {
        process.env.IMQ_REDIS_TLS = 'maybe';

        assert.equal(envTls(), undefined);
    });

    it('should enable TLS implicitly when a trust anchor is supplied', () => {
        process.env.IMQ_REDIS_TLS_CA_FILE = caFile;

        const tls = envTls();

        assert.ok(tls);
        assert.equal(tls.ca?.toString(), 'CA-PEM');
    });

    it('should read a client certificate and key for mutual TLS', () => {
        process.env.IMQ_REDIS_TLS_CERT_FILE = certFile;
        process.env.IMQ_REDIS_TLS_KEY_FILE = keyFile;
        process.env.IMQ_REDIS_TLS_KEY_PASSPHRASE = 'secret';

        const tls = envTls();

        assert.ok(tls);
        assert.equal(tls.cert?.toString(), 'CERT-PEM');
        assert.equal(tls.key?.toString(), 'KEY-PEM');
        assert.equal(tls.passphrase, 'secret');
    });

    it('should carry the expected server name through', () => {
        process.env.IMQ_REDIS_TLS = '1';
        process.env.IMQ_REDIS_TLS_SERVERNAME = 'redis.internal';

        assert.deepEqual(envTls(), { servername: 'redis.internal' });
    });

    it('should let verification be switched off explicitly', () => {
        process.env.IMQ_REDIS_TLS = '1';
        process.env.IMQ_REDIS_TLS_REJECT_UNAUTHORIZED = '0';

        assert.deepEqual(envTls(), { rejectUnauthorized: false });
    });

    it('should not read an enable out of a modifier alone', () => {
        // switching verification off is not a request for TLS, and a server
        // name without one is meaningless - neither may turn encryption on by
        // itself, or a stray variable would silently change the transport
        process.env.IMQ_REDIS_TLS_REJECT_UNAUTHORIZED = '0';
        process.env.IMQ_REDIS_TLS_SERVERNAME = 'redis.internal';

        assert.equal(envTls(), undefined);
    });

    it('should let an explicit off win over supplied material', () => {
        process.env.IMQ_REDIS_TLS = '0';
        process.env.IMQ_REDIS_TLS_CA_FILE = caFile;

        assert.equal(envTls(), undefined);
    });

    it('should throw rather than fall back when material is unreadable', () => {
        process.env.IMQ_REDIS_TLS_CA_FILE = join(dir, 'nowhere.crt');

        assert.throws(
            () => envTls(),
            (err: any) => {
                assert.equal(err.code, 'IMQ_TLS_MATERIAL_UNREADABLE');
                assert.match(err.message, /IMQ_REDIS_TLS_CA_FILE/);

                return true;
            },
        );
    });

    it('should re-read when the environment changes', () => {
        process.env.IMQ_REDIS_TLS = '1';

        const first = envTls();

        process.env.IMQ_REDIS_TLS_SERVERNAME = 'redis.internal';

        const second = envTls();

        assert.deepEqual(first, {});
        assert.deepEqual(second, { servername: 'redis.internal' });
    });

    it('should not re-read the files when nothing changed', () => {
        process.env.IMQ_REDIS_TLS_CA_FILE = caFile;

        assert.equal(envTls(), envTls());
    });
});
