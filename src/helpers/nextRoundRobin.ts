/*!
 * Helper: nextRoundRobin
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
 * Finds the next item, in round-robin order, that a predicate accepts.
 *
 * @typeParam T - item type
 * @param items - the items to choose from
 * @param cursor - where the scan starts; taken modulo the number of items,
 *        so a cursor that ran past the end of a shrunken list is still valid
 * @param accept - whether an item may be chosen
 * @returns the index of the first accepted item at or after the cursor,
 *          wrapping around once, or -1 when none is accepted
 */
export function nextRoundRobin<T>(
    items: readonly T[],
    cursor: number,
    accept: (item: T) => boolean,
): number {
    const count = items.length;
    const start = count ? cursor % count : 0;

    for (let offset = 0; offset < count; offset++) {
        const index = (start + offset) % count;

        if (accept(items[index])) {
            return index;
        }
    }

    return -1;
}
