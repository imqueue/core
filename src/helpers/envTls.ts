/*!
 * Helper: envTls
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
import { readFileSync } from 'node:fs';
import type { ConnectionOptions as TlsOptions } from 'node:tls';

/**
 * Environment variables read by {@link envTls}, in the order they are combined
 * into the resulting configuration.
 */
const ENV_VARS = [
    'IMQ_REDIS_TLS',
    'IMQ_REDIS_TLS_CA_FILE',
    'IMQ_REDIS_TLS_CERT_FILE',
    'IMQ_REDIS_TLS_KEY_FILE',
    'IMQ_REDIS_TLS_KEY_PASSPHRASE',
    'IMQ_REDIS_TLS_SERVERNAME',
    'IMQ_REDIS_TLS_REJECT_UNAUTHORIZED',
] as const;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Result of the last {@link envTls} evaluation, together with the environment
 * it was computed from, so that repeated queue construction re-reads the
 * certificate files only when something actually changed.
 */
let cache: { env: string; tls?: TlsOptions } | undefined;

/**
 * Reads a boolean environment variable.
 *
 * @param name - variable name
 * @returns the parsed value, or `undefined` when unset or unrecognised
 */
function envBool(name: string): boolean | undefined {
    const value = (process.env[name] || '').trim().toLowerCase();

    if (TRUE_VALUES.has(value)) {
        return true;
    }

    if (FALSE_VALUES.has(value)) {
        return false;
    }

    return undefined;
}

/**
 * Reads a file named by an environment variable.
 *
 * @param name - variable name holding the path
 * @returns the file contents, or `undefined` when the variable is unset
 * @throws {Error} when the variable is set but the file cannot be read
 */
function envFile(name: string): Buffer | undefined {
    const path = (process.env[name] || '').trim();

    if (!path) {
        return undefined;
    }

    try {
        return readFileSync(path);
    } catch (err) {
        // deliberately fatal: a mistyped path or an unmounted secret must stop
        // the queue, never quietly leave it talking plaintext to the broker
        const error = new Error(
            `${name}: unable to read TLS material from "${path}": ${
                (err as Error).message
            }`,
        );

        (error as Error & { code: string }).code =
            'IMQ_TLS_MATERIAL_UNREADABLE';

        throw error;
    }
}

/**
 * Builds a TLS configuration from the environment, for turning encryption on
 * across a fleet without touching application code.
 *
 * TLS is enabled by `IMQ_REDIS_TLS`, or implicitly by supplying any TLS
 * material; `IMQ_REDIS_TLS=0` wins over both and disables it outright. The
 * recognised variables are:
 *
 * - `IMQ_REDIS_TLS` — enables TLS with Node's default verification against the
 *   system trust store
 * - `IMQ_REDIS_TLS_CA_FILE` — PEM bundle of the trust anchors to verify the
 *   broker against, for a private CA
 * - `IMQ_REDIS_TLS_CERT_FILE`, `IMQ_REDIS_TLS_KEY_FILE` — client certificate
 *   and its private key, for mutual TLS
 * - `IMQ_REDIS_TLS_KEY_PASSPHRASE` — passphrase of an encrypted private key
 * - `IMQ_REDIS_TLS_SERVERNAME` — expected certificate name, needed when the
 *   broker is reached at an address the certificate does not carry
 * - `IMQ_REDIS_TLS_REJECT_UNAUTHORIZED` — set to `0` to accept an unverified
 *   certificate. This reduces the connection to encryption without
 *   authentication and leaves it open to interception; use it for a local
 *   experiment, never in a deployment.
 *
 * Certificate files are read eagerly, and an unreadable one throws rather than
 * yielding a configuration that would connect in the clear.
 *
 * @returns the configuration, or `undefined` when the environment asks for no
 *          TLS
 * @throws {Error} when TLS material is named but cannot be read
 */
export function envTls(): TlsOptions | undefined {
    const env = ENV_VARS.map(name => `${name}=${process.env[name] ?? ''}`).join(
        '\n',
    );

    if (cache && cache.env === env) {
        return cache.tls;
    }

    const enabled = envBool('IMQ_REDIS_TLS');
    const tls: TlsOptions = {};

    if (enabled === false) {
        cache = { env, tls: undefined };

        return undefined;
    }

    const ca = envFile('IMQ_REDIS_TLS_CA_FILE');
    const cert = envFile('IMQ_REDIS_TLS_CERT_FILE');
    const key = envFile('IMQ_REDIS_TLS_KEY_FILE');
    const passphrase = (process.env.IMQ_REDIS_TLS_KEY_PASSPHRASE || '').trim();
    const servername = (process.env.IMQ_REDIS_TLS_SERVERNAME || '').trim();
    const rejectUnauthorized = envBool('IMQ_REDIS_TLS_REJECT_UNAUTHORIZED');

    if (ca) {
        tls.ca = ca;
    }

    if (cert) {
        tls.cert = cert;
    }

    if (key) {
        tls.key = key;
    }

    if (passphrase) {
        tls.passphrase = passphrase;
    }

    if (servername) {
        tls.servername = servername;
    }

    if (rejectUnauthorized !== undefined) {
        tls.rejectUnauthorized = rejectUnauthorized;
    }

    // an explicit switch turns TLS on by itself; so does supplying key
    // material, which is only ever meaningful with TLS on. The remaining
    // variables only shape a connection someone else has asked for - reading
    // an enable out of `rejectUnauthorized=0` would be perverse.
    const on = enabled === true || !!(ca || cert || key);

    cache = { env, tls: on ? tls : undefined };

    return cache.tls;
}
