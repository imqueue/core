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
 * Harness bringing up a throwaway, TLS-only redis for the integration specs,
 * and reporting - rather than throwing - when the machine cannot host one.
 *
 * Everything it needs beyond `redis-server` and `openssl` is generated into a
 * temporary directory that is removed on teardown, and the broker listens on a
 * port picked at run time, so a developer's own redis is never touched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The only name the broker's certificate carries - and not an address */
const SERVER_NAME = 'redis-broker.internal';

/** How long the broker is given to come up before it is called a failure */
const READY_TIMEOUT = 10000;

/** Gap between readiness probes while the broker is starting */
const PROBE_INTERVAL = 100;

/**
 * A running TLS-only redis, together with the material needed to talk to it.
 */
export interface TlsBroker {
    /** Port the broker accepts TLS connections on; it has no plaintext one */
    port: number;

    /** The certificate authority both sides are issued by */
    ca: Buffer;

    /** Client certificate and key, for the mutual-TLS broker */
    cert: Buffer;
    key: Buffer;

    /**
     * The name on the server certificate. It is deliberately not the address
     * the specs dial, so pinning it is the only thing that makes verification
     * succeed.
     */
    servername: string;

    /** Paths of the same material, for exercising the environment options */
    paths: { ca: string; cert: string; key: string };

    /** Stops the broker and removes everything it was given */
    stop(): Promise<void>;
}

/**
 * Why this machine cannot run the integration specs, or `undefined` when it
 * can. Reported as a skip reason rather than raised: a checkout without redis
 * installed - CI, most obviously - must report these specs as skipped and go
 * on to pass.
 */
export type SkipReason = string | undefined;

/**
 * Asks the operating system for a free port by binding one and letting it go
 * again.
 *
 * @returns a port that was free a moment ago
 *
 * @remarks
 * Inherently a moment out of date by the time the broker binds it. Nothing
 * else in the suite listens, so the window only matters against unrelated
 * software on the same machine, and a collision surfaces as a start failure
 * and a skip rather than a wrong result.
 */
async function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const probe = createServer();

        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const port =
                typeof address === 'object' && address ? address.port : 0;

            probe.close(() =>
                port
                    ? resolve(port)
                    : reject(new Error('could not determine a free port')),
            );
        });
    });
}

/**
 * Confirms an executable is on `PATH` and runnable.
 *
 * @param command - the executable to look for
 * @returns true when it answered
 */
async function have(command: string): Promise<boolean> {
    try {
        await run(command, ['--version']);

        return true;
    } catch {
        return false;
    }
}

/**
 * Issues a private certificate authority, a server certificate valid for
 * `localhost`, and a client certificate off the same authority.
 *
 * @param dir - directory to write the material into
 */
async function issueCertificates(dir: string): Promise<void> {
    const at = (name: string): string => join(dir, name);

    // deliberately a name and no IP SAN. A broker announced by address cannot
    // have that address known when its certificate is issued, so the specs dial
    // an IP against a certificate carrying none - which is verifiable only by
    // pinning `servername`, and is the shape a deployment that discovers
    // brokers by IP actually runs in
    await writeFile(at('server.ext'), `subjectAltName=DNS:${SERVER_NAME}\n`);

    await run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        at('ca.key'),
        '-out',
        at('ca.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=imq-integration-ca',
    ]);

    for (const [name, subject, ext] of [
        ['server', `/CN=${SERVER_NAME}`, at('server.ext')],
        ['client', '/CN=imq-integration-client', undefined],
    ] as Array<[string, string, string | undefined]>) {
        await run('openssl', [
            'req',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            at(`${name}.key`),
            '-out',
            at(`${name}.csr`),
            '-subj',
            subject,
        ]);
        await run('openssl', [
            'x509',
            '-req',
            '-in',
            at(`${name}.csr`),
            '-CA',
            at('ca.crt'),
            '-CAkey',
            at('ca.key'),
            '-CAcreateserial',
            '-out',
            at(`${name}.crt`),
            '-days',
            '1',
            ...(ext ? ['-extfile', ext] : []),
        ]);
    }
}

/**
 * Probes the broker by completing a TLS handshake and issuing a `PING`.
 *
 * @param port - port to dial
 * @param ca - authority to verify the broker against
 * @param cert - client certificate, when the broker demands one
 * @param key - its private key
 * @returns true once the broker answers `+PONG`
 */
async function pings(
    port: number,
    ca: Buffer,
    cert: Buffer,
    key: Buffer,
): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const socket = tlsConnect(
            { port, host: '127.0.0.1', ca, cert, key, servername: SERVER_NAME },
            () => socket.write('PING\r\n'),
        );

        const done = (answered: boolean): void => {
            socket.destroy();
            resolve(answered);
        };

        socket.setTimeout(PROBE_INTERVAL * 10, () => done(false));
        socket.once('error', () => done(false));
        socket.once('data', data => done(data.toString().startsWith('+PONG')));
    });
}

/** Resolves after the given number of milliseconds */
const wait = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

/**
 * Brings up a TLS-only redis for one spec file.
 *
 * The broker is started with `--port 0`, so it has no plaintext listener at
 * all: a queue that reaches it has demonstrably done so over TLS, which is the
 * property these specs exist to check and the one a mock can never establish.
 *
 * @param mutual - whether the broker demands a client certificate
 * @returns the running broker, or the reason this machine cannot host one
 */
export async function startTlsBroker(
    mutual: boolean = false,
): Promise<TlsBroker | SkipReason> {
    for (const command of ['redis-server', 'openssl']) {
        if (!(await have(command))) {
            return `${command} is not available on this machine`;
        }
    }

    const dir = await mkdtemp(join(tmpdir(), 'imq-integration-'));
    let redis: ChildProcess | undefined;

    // a child is not reaped with its parent on POSIX, so a crashed or
    // interrupted run would otherwise leave a redis behind holding a port
    const reap = (): void => {
        redis?.kill('SIGKILL');
    };

    const cleanup = async (): Promise<void> => {
        process.removeListener('exit', reap);

        if (redis && redis.exitCode === null && redis.signalCode === null) {
            const exited = new Promise<void>(resolve =>
                redis?.once('exit', () => resolve()),
            );

            redis.kill('SIGKILL');
            await exited;
        }

        await rm(dir, { recursive: true, force: true });
    };

    try {
        await issueCertificates(dir);

        const port = await freePort();
        const log = join(dir, 'redis.log');

        process.once('exit', reap);

        redis = spawn(
            'redis-server',
            [
                '--port',
                '0',
                '--tls-port',
                String(port),
                '--tls-cert-file',
                join(dir, 'server.crt'),
                '--tls-key-file',
                join(dir, 'server.key'),
                '--tls-ca-cert-file',
                join(dir, 'ca.crt'),
                '--tls-auth-clients',
                mutual ? 'yes' : 'no',
                '--notify-keyspace-events',
                'Ex',
                '--logfile',
                log,
                '--dir',
                dir,
                '--save',
                '',
            ],
            { stdio: 'ignore' },
        );

        const paths = {
            ca: join(dir, 'ca.crt'),
            cert: join(dir, 'client.crt'),
            key: join(dir, 'client.key'),
        };
        const [ca, cert, key] = await Promise.all([
            readFile(paths.ca),
            readFile(paths.cert),
            readFile(paths.key),
        ]);

        const deadline = Date.now() + READY_TIMEOUT;

        while (Date.now() < deadline) {
            if (redis.exitCode !== null || redis.signalCode !== null) {
                break;
            }

            if (await pings(port, ca, cert, key)) {
                return {
                    port,
                    ca,
                    cert,
                    key,
                    paths,
                    servername: SERVER_NAME,
                    stop: cleanup,
                };
            }

            await wait(PROBE_INTERVAL);
        }

        // a redis built without TLS is the usual reason, and its own log says
        // so far more usefully than anything inferred out here
        const reason = await readFile(log, 'utf8').catch(() => '');

        await cleanup();

        return (
            'redis-server would not start with TLS enabled' +
            (reason.trim() ? `: ${reason.trim().split('\n').pop()}` : '')
        );
    } catch (err) {
        await cleanup();

        return `could not prepare a TLS broker: ${(err as Error).message}`;
    }
}
