/*!
 * Copies identical EventEmitter to the target
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
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';

/**
 * Re-attaches every listener registered on one emitter to another.
 *
 * @param source - emitter to copy listeners from; left untouched
 * @param target - emitter to attach them to, in addition to whatever it already
 *        has
 *
 * @remarks
 * Used when a queue handle is replaced by another instance that must keep
 * serving the original's listeners — the caller registered them on the object
 * it was given, and has no way to know it was swapped.
 *
 * `once` listeners stay `once`. They are detected by inspecting the wrapper
 * Node puts around them, and the wrapped listener is unwrapped through its
 * `.listener` property before being re-registered, so a one-shot listener does
 * not silently become permanent on the target.
 *
 * The max-listeners limit is carried across too, but only when the source has
 * one set: reading it unconditionally would replace the target's default with
 * Node's, which is the same number today and need not stay so.
 */
export function copyEventEmitter(
    source: EventEmitter & {
        _maxListeners?: number;
        _events?: Record<string | symbol, any>;
    },
    target: EventEmitter,
): void {
    if (typeof source._maxListeners !== 'undefined') {
        target.setMaxListeners(source.getMaxListeners());
    }

    for (const event of source.eventNames()) {
        const listeners = source.rawListeners(event) as any[];

        for (const originalListener of listeners) {
            if (inspect(originalListener).includes('onceWrapper')) {
                const realListener =
                    originalListener?.listener || originalListener;

                target.once(event, realListener);
            } else {
                target.on(event, originalListener);
            }
        }
    }
}
