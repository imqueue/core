/*!
 * Helper: logging
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
/**
 * Upper bound on the number of channel names the no-subscriber transition
 * state of a queue remembers. Channel names arrive as an unbounded stream of
 * unique client-queue names, so the set must not grow with them: names above
 * the bound are simply not remembered.
 */
export const LOG_MAX_KEYS = 128;

/**
 * Redis error replies this helper is allowed to quote. The leading token of a
 * Redis error reply is a protocol constant, never data — but only these are
 * recognised, so an arbitrary upper-case first word of some other error's
 * message can never reach the log.
 */
const REDIS_REPLY_CODES: Set<string> = new Set([
    'ASK',
    'BUSY',
    'BUSYGROUP',
    'CLUSTERDOWN',
    'CROSSSLOT',
    'ERR',
    'EXECABORT',
    'LOADING',
    'MASTERDOWN',
    'MISCONF',
    'MOVED',
    'NOAUTH',
    'NOGROUP',
    'NOPERM',
    'NOPROTO',
    'NOREPLICAS',
    'NOSCRIPT',
    'NOTBUSY',
    'OOM',
    'READONLY',
    'TRYAGAIN',
    'UNBLOCKED',
    'UNKILLABLE',
    'WRONGPASS',
    'WRONGTYPE',
]);

/**
 * Transport failures the redis client reports by message only, mapped to a
 * code of our own. The patterns are fixed library strings, so nothing from an
 * application error can match them.
 */
const CLIENT_MESSAGE_CODES: Array<[RegExp, string]> = [
    [/^Connection is closed/i, 'CONNECTION_CLOSED'],
    [/^Stream connection ended/i, 'STREAM_ENDED'],
    [/^Reached the max retries per request limit/i, 'MAX_RETRIES'],
    [/^Command timed out/i, 'COMMAND_TIMEOUT'],
];

/**
 * Shape of an `err.code` this helper accepts: an `IMQ_`-prefixed code of the
 * framework itself, or a system errno such as `ECONNREFUSED`.
 */
const SAFE_CODE = /^(IMQ_[A-Z0-9_]{1,48}|E[A-Z]{2,15})$/;

/** Upper bound of a numeric `err.code`, so that no long number can pass */
const MAX_NUMERIC_CODE = 65535;

/**
 * Extracts a loggable failure code from an unknown thrown value.
 *
 * @param err - the caught value, of any shape
 * @returns the code, or `unknown` when none can be told safely
 *
 * @remarks
 * Deliberately conservative: only an allow-listed code can come out of here,
 * because an application error reaches this helper too and anything of its own
 * may carry personal data. Recognised are a framework or system `code`, a
 * small numeric `code`, the leading token of a known Redis error reply and a
 * known redis-client failure message. Everything else — including the error's
 * message, its stack and its class name — yields `unknown`. Never throws.
 */
export function errorCode(err: unknown): string {
    try {
        const code = (err as { code?: unknown } | undefined)?.code;

        if (
            typeof code === 'number' &&
            Number.isInteger(code) &&
            code >= 0 &&
            code <= MAX_NUMERIC_CODE
        ) {
            return String(code);
        }

        if (
            typeof code === 'string' &&
            (SAFE_CODE.test(code) || REDIS_REPLY_CODES.has(code))
        ) {
            return code;
        }

        const message = (err as { message?: unknown } | undefined)?.message;

        if (typeof message === 'string') {
            const reply = message.split(' ', 1)[0];

            if (REDIS_REPLY_CODES.has(reply)) {
                return reply;
            }

            for (const [pattern, mapped] of CLIENT_MESSAGE_CODES) {
                if (pattern.test(message)) {
                    return mapped;
                }
            }
        }

        return 'unknown';
    } catch {
        return 'unknown';
    }
}
