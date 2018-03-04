
/*!
 * Unified Unique ID Generator
 * Based on solution inspired by Jeff Ward and the comments to it:
 * @see http://stackoverflow.com/a/21963136/1511662
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
const lookupTable: string[] = [];

for (let i = 0; i < 256; i++) {
    lookupTable[i] = (i < 16 ? '0' : '') + (i).toString(16);
}

const rand = Math.random;

/**
 * Generates and returns Unified Unique Identifier
 *
 * @returns {string}
 */
export function uuid() {
    let d0 = rand() * 0x100000000 >>> 0;
    let d1 = rand() * 0x100000000 >>> 0;
    let d2 = rand() * 0x100000000 >>> 0;
    let d3 = rand() * 0x100000000 >>> 0;

    return lookupTable[d0 & 0xff] +
        lookupTable[d0 >> 8 & 0xff] +
        lookupTable[d0 >> 16 & 0xff] +
        lookupTable[d0 >> 24 & 0xff] +
        '-' +
        lookupTable[d1 & 0xff] +
        lookupTable[d1 >> 8 & 0xff] +
        '-' +
        lookupTable[d1 >> 16 & 0x0f | 0x40] +
        lookupTable[d1 >> 24 & 0xff] +
        '-' +
        lookupTable[d2 & 0x3f | 0x80] +
        lookupTable[d2 >> 8 & 0xff] +
        '-' +
        lookupTable[d2 >> 16 & 0xff] +
        lookupTable[d2 >> 24 & 0xff] +
        lookupTable[d3 & 0xff] +
        lookupTable[d3 >> 8 & 0xff] +
        lookupTable[d3 >> 16 & 0xff] +
        lookupTable[d3 >> 24 & 0xff];
}
