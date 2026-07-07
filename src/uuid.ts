/*!
 * Unified Unique ID Generator
 * Based on solution inspired by Jeff Ward and the comments to it:
 * @see http://stackoverflow.com/a/21963136/1511662
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
const lookupTable: string[] = [];

for (let i = 0; i < 256; i++) {
    lookupTable[i] = (i < 16 ? '0' : '') + (i).toString(16);
}

const rand = Math.random.bind(Math);

/**
 * Generates and returns Unified Unique Identifier
 *
 * @returns {string}
 */
export function uuid(): string {
    const d0 = rand() * 0x100000000 >>> 0;
    const d1 = rand() * 0x100000000 >>> 0;
    const d2 = rand() * 0x100000000 >>> 0;
    const d3 = rand() * 0x100000000 >>> 0;

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
