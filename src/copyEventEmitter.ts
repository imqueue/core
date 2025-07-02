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
import { EventEmitter } from 'events';
import * as util from 'util';

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
            if (util.inspect(originalListener).includes('onceWrapper')) {
                const realListener = originalListener?.listener
                    || originalListener;

                target.once(event, realListener);
            } else {
                target.on(event, originalListener);
            }
        }
    }
}
