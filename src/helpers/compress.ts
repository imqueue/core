/*!
 * Helper: compress — zstd for large messages, and a reader for every format
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
import zlib from 'node:zlib';
import { unpack as gunpack } from './unpack.js';

/**
 * What a zstd-compressed message starts with. A JSON envelope starts with
 * `{` and a gzipped one with `\x1f`, so one character tells the three apart.
 */
export const ZSTD_MARK = 'Z';

const GZIP_MARK = 0x1f;

/** Whether this Node can write and read zstd at all (22.15 and later). */
export const ZSTD_AVAILABLE =
    typeof zlib.zstdCompressSync === 'function' &&
    typeof zlib.zstdDecompressSync === 'function';

/**
 * Builds the serializer a queue writes with.
 *
 * @param useGzip - gzip every message, as {@link IMQOptions.useGzip} says
 * @param compressAbove - zstd any message whose JSON is longer than this many
 *        characters; `0` never does
 * @returns the serializer
 *
 * @remarks
 * zstd at its fastest level shrinks a 4.6 MB description about sixteen times
 * for about 3 ms of CPU, and is skipped below the threshold, where a message
 * is cheaper to send than to compress. The compressed bytes travel as base64,
 * because the queue reads strings and a binary string does not survive the
 * UTF-8 round trip unchanged in size.
 */
export function packer(
    useGzip: boolean,
    compressAbove: number,
): (data: unknown) => string {
    if (useGzip) {
        return data => zlib.gzipSync(JSON.stringify(data)).toString('binary');
    }

    if (!(compressAbove > 0) || !ZSTD_AVAILABLE) {
        return data => JSON.stringify(data);
    }

    return data => {
        const json = JSON.stringify(data);

        if (json.length <= compressAbove) {
            return json;
        }

        return (
            ZSTD_MARK +
            zlib
                .zstdCompressSync(Buffer.from(json), {
                    params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
                })
                .toString('base64')
        );
    };
}

/**
 * Reads a message in whichever of the three formats it was written: plain
 * JSON, gzip, or zstd.
 *
 * @param data - the message as read off the queue
 * @returns the deserialized value
 * @throws when the message is malformed, or is zstd on a Node that cannot
 *         read it
 *
 * @remarks
 * A reader taking every format is what lets a fleet turn compression on one
 * writer at a time: every reader is upgraded first, and no writer has to
 * agree with a reader about a setting.
 */
export function unpackAny(data: string): unknown {
    if (data.charCodeAt(0) === GZIP_MARK) {
        return gunpack(data);
    }

    if (data.startsWith(ZSTD_MARK)) {
        if (!ZSTD_AVAILABLE) {
            throw new TypeError(
                'IMQ: a zstd message arrived, and this Node cannot read zstd',
            );
        }

        return JSON.parse(
            zlib
                .zstdDecompressSync(Buffer.from(data.slice(1), 'base64'))
                .toString(),
        ) as unknown;
    }

    return JSON.parse(data) as unknown;
}
