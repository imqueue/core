/*!
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
 * Operating mode of a queue instance, selecting which halves of the queue are
 * active. Passed as the third constructor argument and defaults to
 * {@link IMQMode.BOTH}.
 *
 * All modes still open a writer connection and take part in watcher election;
 * the mode only controls whether a reader is created and whether sending is
 * allowed.
 *
 * @remarks
 * The members carry implicit numeric values and `BOTH` is `0`, so a falsy check
 * such as `mode || IMQMode.WORKER` silently resolves to `WORKER`. Do not
 * persist these values either — they shift if the members are reordered.
 */
export enum IMQMode {
    /**
     * Consume and produce. This is the default.
     */
    BOTH,
    /**
     * Consume only. No messages can be sent — `send()` throws a `TypeError`.
     */
    WORKER,
    /**
     * Produce only. No reader connection is opened, so the queue never emits
     * `message` events and never releases delayed messages.
     */
    PUBLISHER,
}
