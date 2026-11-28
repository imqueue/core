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
 * UDPClusterManager signal handling, end to end: a real child process and a
 * real `SIGTERM`.
 *
 * These cannot be in-process tests — what is under test is whether the
 * process is signalled again and whether it terminates, so each case spawns
 * `test/fixtures/udpSignalHost.js` and reads the JSON progress lines it emits.
 * The child preloads the same mocks as this runner, so it opens no socket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(
    new URL('../fixtures/udpSignalHost.js', import.meta.url),
);
const MOCKS = fileURLToPath(new URL('../mocks/index.js', import.meta.url));

interface HostEvent {
    event: string;
    [key: string]: unknown;
}

interface HostRun {
    events: HostEvent[];
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Runs the host fixture in the given mode, sends it one `SIGTERM` once it is
 * ready, and collects what it reported.
 *
 * @param mode - who else listens for the signal in the host
 */
function run(mode: 'alone' | 'owner' | 'once'): Promise<HostRun> {
    return new Promise<HostRun>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--experimental-test-module-mocks', '--import', MOCKS, FIXTURE],
            {
                env: { ...process.env, UDP_SIGNAL_HOST_MODE: mode },
                stdio: 'pipe',
            },
        );
        const events: HostEvent[] = [];
        let buffered = '';
        let stderr = '';
        let signalled = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => (stderr += chunk));
        child.stdout.on('data', chunk => {
            buffered += chunk;

            const lines = buffered.split('\n');

            buffered = lines.pop() as string;

            for (const line of lines) {
                if (!line.startsWith('{')) {
                    continue;
                }

                const event = JSON.parse(line) as HostEvent;

                events.push(event);

                if (event.event === 'ready' && !signalled) {
                    signalled = true;
                    child.kill('SIGTERM');
                }
            }
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            resolve({ events, stderr, code, signal });
        });
    });
}

/**
 * The deliveries of the signal the host's own listener reported.
 *
 * @param result - a finished host run
 */
function deliveries(result: HostRun): number {
    return result.events.filter(e => e.event === 'signal').length;
}

describe('UDPClusterManager signal handling in a real process', () => {
    it('terminates the process on the signal when nothing else listens', async () => {
        const result = await run('alone');

        assert.equal(result.signal, 'SIGTERM', result.stderr);
        assert.equal(
            result.events.some(e => e.event === 'timeout'),
            false,
        );
    });

    it('delivers one SIGTERM once to a persistent listener that owns shutdown', async () => {
        const result = await run('owner');
        const done = result.events.find(e => e.event === 'done');

        assert.ok(done, `the owner never finished: ${result.stderr}`);
        assert.equal(done.received, 1);
        assert.equal(deliveries(result), 1);
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
    });

    it('still terminates when the only other listener was registered once', async () => {
        const result = await run('once');

        assert.equal(deliveries(result), 1);
        assert.equal(result.signal, 'SIGTERM', result.stderr);
    });
});
