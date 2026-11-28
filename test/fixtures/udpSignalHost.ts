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
 * A host process holding a {@link UDPClusterManager} with signal handling on,
 * for `test/unit/UDPClusterManager.signals.spec.ts` to send a real `SIGTERM`.
 *
 * `UDP_SIGNAL_HOST_MODE` picks who else listens for the signal:
 *
 * - `alone`: nobody — the manager's re-raise must terminate the process;
 * - `owner`: a persistent listener registered after the manager, as a
 *   draining service registers its own. It counts the deliveries it receives
 *   and, once the manager has stopped its workers, reports the count and
 *   exits `0` itself;
 * - `once`: a `once` listener that never exits — gone by the time the manager
 *   would re-raise, so the process must still terminate on the signal.
 *
 * Progress is written to stdout as one JSON object per line.
 */
import { UDPClusterManager } from '../../src/index.js';

/** How long the host may live before it gives up and exits on its own. */
const LIFETIME = 10000;
/**
 * How long the owner keeps listening after the manager stopped its workers:
 * room for a re-raised signal, sent synchronously right after, to arrive.
 */
const SETTLE = 200;

const mode = process.env.UDP_SIGNAL_HOST_MODE || 'alone';

/**
 * Writes one progress line.
 *
 * @param event - what happened
 * @param data - anything to report with it
 */
function report(event: string, data: Record<string, unknown> = {}): void {
    process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

/**
 * Resolves once every worker the managers in this process run is stopped.
 */
async function workersStopped(): Promise<void> {
    const workers = (UDPClusterManager as any).workers as Record<
        string,
        unknown
    >;

    while (Object.keys(workers).length) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

// the keep-alive guarantees a natural exit never passes for a terminated
// process, and the deadline that a hang never passes for a test that ends
const keepAlive = setInterval(() => undefined, 1000);

setTimeout(() => {
    report('timeout');
    clearInterval(keepAlive);
    process.exit(3);
}, LIFETIME).unref();

new UDPClusterManager();

if (mode === 'owner') {
    let received = 0;

    process.on('SIGTERM', () => {
        received++;
        report('signal', { received });

        if (received > 1) {
            return;
        }

        void workersStopped()
            .then(() => new Promise(resolve => setTimeout(resolve, SETTLE)))
            .then(() => {
                report('done', { received });
                process.exit(0);
            });
    });
}

if (mode === 'once') {
    process.once('SIGTERM', () => report('signal', { received: 1 }));
}

report('ready', { mode });
