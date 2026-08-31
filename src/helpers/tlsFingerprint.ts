/*!
 * Helper: tlsFingerprint
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
import { sha1 } from './sha1.js';
import type { ConnectionOptions as TlsOptions } from 'node:tls';

/**
 * Renders an arbitrary TLS option value as a stable string, so that two
 * structurally identical configurations built independently produce the same
 * text and two differing ones do not.
 *
 * @param value - the option value to render
 * @returns a deterministic textual form of the value
 */
function canonical(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    if (value === undefined) {
        return 'undefined';
    }

    if (typeof value === 'function') {
        // a verifier or a PSK callback is part of the security posture: two
        // connections differing only in it must not be pooled together
        return `fn:${sha1(value.toString())}`;
    }

    if (typeof value !== 'object') {
        return JSON.stringify(value) as string;
    }

    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;

        return `bin:${sha1(
            Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
                'base64',
            ),
        )}`;
    }

    if (value instanceof ArrayBuffer) {
        return `bin:${sha1(Buffer.from(value).toString('base64'))}`;
    }

    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        // an opaque host object - a SecureContext, an Agent - has no readable
        // structure to compare, so it is rendered by type alone. Two distinct
        // instances of the same class therefore collide; pass the material
        // itself rather than a prebuilt context if that matters.
        return `obj:${(value as object).constructor?.name || 'unknown'}`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);

    return `{${entries.join(',')}}`;
}

/**
 * Computes a stable fingerprint of a TLS configuration, used to keep
 * connections that differ in their transport security out of the same
 * connection pool slot.
 *
 * Two configurations that are equal by value share a fingerprint, so pooling
 * still works across independently built option literals. Any difference in
 * the trust anchors, the client certificate, the verification callbacks or the
 * expected server name yields a different one.
 *
 * @param tls - the TLS configuration, as accepted by {@link IMQOptions.tls}
 * @returns a hex digest identifying the configuration
 */
export function tlsFingerprint(tls: boolean | TlsOptions): string {
    return sha1(canonical(tls === true ? {} : tls));
}
