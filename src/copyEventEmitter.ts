/*!
 * Copies identical EventEmitter to the target
 *
 *
 * Copyright (c) 2025, imqueue.com <support@imqueue.com>
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
