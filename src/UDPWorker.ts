/*!
 * UDP message listener for cluster managing: Worker for processing
 * messages
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
import {
    isMainThread,
    parentPort,
    workerData,
    MessagePort,
} from 'node:worker_threads';
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { type UDPWorkerOptions } from './UDPClusterManager.js';

/**
 * What a broadcast announcement is saying about its sender.
 */
enum MessageType {
    /** The sender is available and should be in the cluster */
    Up = 'up',
    /** The sender is going away and should be dropped from the cluster */
    Down = 'down',
}

/**
 * One decoded broadcast announcement.
 *
 * @remarks
 * The wire form is a tab-separated line, `name\tid\ttype\thost:port\ttimeout`,
 * with the timeout in **seconds**; {@link UDPWorker.parseMessage} converts it to
 * milliseconds and rejects anything malformed.
 */
interface Message {
    /** Identifier of the announcing instance, unique per sender */
    id: string;
    /** Cluster name the sender belongs to; senders of other names are ignored */
    name: string;
    /** Whether the sender is joining or leaving */
    type: MessageType;
    /** Host the sender's redis is reachable on */
    host: string;
    /** Port the sender's redis is reachable on */
    port: number;
    /** How long (ms) the sender may go unheard before it is presumed gone */
    timeout: number;
}

/**
 * The worker-thread half of {@link UDPClusterManager}: listens for UDP
 * broadcast announcements and reports cluster membership back to the main
 * thread.
 *
 * @remarks
 * Instantiated automatically at the bottom of this module when it is loaded as
 * a worker thread, so it is never constructed by hand. It owns the socket and
 * the liveness timers, which is the point — keeping the datagram traffic and
 * its timers off the main thread means a busy queue cannot delay membership
 * updates, and a socket failure cannot crash the process.
 *
 * It talks to the main thread in one direction only: `cluster:add`,
 * `cluster:remove`, `error` and `stopped` messages out, a `stop` message in.
 */
export class UDPWorker {
    /** The bound UDP socket announcements arrive on */
    private readonly socket: Socket;
    /**
     * Last announcement stamp seen per server, keyed by the announcing
     * instance's id.
     *
     * @remarks
     * The value is a per-announcement uuid rather than a timestamp: a liveness
     * timer only removes a server if the stamp it captured is still the current
     * one, so a fresh announcement silently invalidates the timer that was
     * waiting on the previous one.
     */
    private readonly servers = new Map<string, string>();

    /**
     * Binds the socket and starts listening for announcements.
     *
     * @param options - worker configuration, passed through `workerData`
     * @param messagePort - the port back to the main thread
     */
    constructor(
        /** Worker configuration, delivered through `workerData` */
        private readonly options: UDPWorkerOptions,
        /** The port every membership update and error is reported over */
        private readonly messagePort: MessagePort,
    ) {
        this.setupMessageHandlers();
        this.socket = createSocket({
            type: 'udp4',
            reuseAddr: true,
            reusePort: true,
        });
        // surface socket failures (bind errors, network errors) to the
        // main thread instead of crashing the whole process with an
        // unhandled 'error' event
        this.socket.on('error', err => {
            this.messagePort.postMessage({
                type: 'error',
                error: err.message,
            });
        });
        this.socket.on('message', input => {
            // a malformed datagram on the broadcast port must never crash
            // the worker (and, through it, the host process)
            try {
                const message = this.parseMessage(input);

                if (message) {
                    this.processMessage(message);
                }
            } catch {
                // ignore broken datagrams
            }
        });
        this.socket.bind(this.options.port, this.selectNetworkInterface());
    }

    /**
     * Identifies the server an announcement is about.
     *
     * @param message - the announcement
     * @returns the key its liveness stamp is tracked under
     *
     * @remarks
     * The sender's own id, not its `host:port`: two instances may legitimately
     * advertise the same address, and keying by address would let one of them
     * expire the other's entry.
     */
    private static getServerKey(message: Message): string {
        return message.id;
    }

    /**
     * Listens for instructions from the main thread. `stop` is the only one.
     */
    private setupMessageHandlers(): void {
        this.messagePort.on('message', message => {
            if (message.type === 'stop') {
                this.stop();
            }
        });
    }

    /**
     * Reports a server as part of the cluster, and starts its liveness timer
     * when {@link UDPWorkerOptions.useAliveCheck} is on.
     *
     * @param message - the announcement that named it
     */
    private addServer(message: Message): void {
        this.messagePort.postMessage({
            type: 'cluster:add',
            server: UDPWorker.mapMessage(message),
        });

        if (this.options.useAliveCheck) {
            this.serverAliveWait(message);
        }
    }

    /**
     * Drops a server from the cluster and forgets its liveness stamp.
     *
     * @param message - the announcement that named it, whether a `down` notice
     *        or the stale `up` whose liveness timer expired
     */
    private removeServer(message: Message): void {
        this.servers.delete(UDPWorker.getServerKey(message));
        this.messagePort.postMessage({
            type: 'cluster:remove',
            server: UDPWorker.mapMessage(message),
        });
    }

    /**
     * Copies an announcement field by field before it crosses to the main
     * thread.
     *
     * @param message - the announcement to copy
     * @returns a plain object safe to post through the message port
     */
    private static mapMessage(message: Message): Message {
        return {
            id: message.id,
            name: message.name,
            type: message.type,
            host: message.host,
            port: message.port,
            timeout: message.timeout,
        };
    }

    /**
     * Arms the timer that drops a server which stops announcing itself.
     *
     * @param message - the announcement that renewed it
     *
     * @remarks
     * The timer waits the sender's own timeout plus
     * {@link UDPWorkerOptions.aliveTimeoutCorrection} and a millisecond, so a
     * sender that announces exactly on its own deadline is not dropped by a
     * race. It is unref'd: a pending liveness timer must not keep the worker
     * thread alive on its own.
     *
     * Only the timer holding the current stamp may remove the server, so each
     * new announcement supersedes the one before it without cancelling timers.
     */
    private serverAliveWait(message: Message): void {
        const stamp = randomUUID();
        const correction = this.options.aliveTimeoutCorrection ?? 0;
        const effectiveTimeout = message.timeout + correction + 1;
        const key = UDPWorker.getServerKey(message);

        this.servers.set(key, stamp);

        const timer: NodeJS.Timeout = setTimeout(
            () =>
                setImmediate(() => {
                    if (this.servers.get(key) === stamp) {
                        this.removeServer(message);
                    }
                }),
            effectiveTimeout,
        );

        // a pending liveness timer must not keep the worker alive on its own
        timer.unref();
    }

    /**
     * Routes one decoded announcement to add or remove its sender.
     *
     * @param message - the decoded announcement; an unrecognised type is
     *        ignored rather than treated as either
     */
    private processMessage(message: Message): void {
        if (message.type === MessageType.Down) {
            return this.removeServer(message);
        }

        if (message.type === MessageType.Up) {
            return this.addServer(message);
        }
    }

    /**
     * Chooses the local address to bind the broadcast socket to.
     *
     * @returns the address of the interface carrying the configured broadcast
     *          address, or `0.0.0.0` when none matches
     *
     * @remarks
     * Binding to the specific interface rather than to every one keeps the
     * worker from receiving the same announcement on several interfaces at
     * once. Falling back to `0.0.0.0` is deliberate: a misconfigured broadcast
     * address should degrade to hearing everything rather than to hearing
     * nothing.
     */
    private selectNetworkInterface(): string {
        const interfaces = networkInterfaces();
        const broadcastAddress =
            this.options.address || this.options.limitedAddress;
        const defaultAddress = '0.0.0.0';

        if (
            !broadcastAddress ||
            broadcastAddress === this.options.limitedAddress
        ) {
            return defaultAddress;
        }

        for (const key in interfaces) {
            if (!interfaces[key]) {
                continue;
            }

            for (const net of interfaces[key]) {
                const shouldBeSelected =
                    net.family === 'IPv4' &&
                    net.address.startsWith(
                        broadcastAddress.replace(/\.255/g, ''),
                    );

                if (shouldBeSelected) {
                    return net.address;
                }
            }
        }

        return defaultAddress;
    }

    /**
     * Parses a raw broadcast datagram into a message. Returns null for
     * malformed input (missing fields, non-numeric port, or timeout), so
     * garbage on the broadcast port is dropped instead of producing
     * NaN-driven timers or crashes.
     *
     * @param {Buffer} input
     * @returns {Message | null}
     */
    /**
     * Decodes one datagram.
     *
     * @param input - the raw datagram
     * @returns the decoded announcement, or `null` when it is malformed —
     *          a missing field, an out-of-range port, or an unparseable
     *          timeout. Datagrams arrive from anywhere on the network, so
     *          anything unrecognised is dropped rather than trusted
     *
     * @remarks
     * The wire timeout is in seconds and is returned in milliseconds.
     */
    private parseMessage(input: Buffer): Message | null {
        const [name, id, type, address = '', timeout = '0'] = input
            .toString()
            .split('\t');
        const [host, port = ''] = address.split(':');
        const portNumber = parseInt(port, 10);
        const timeoutMs = parseFloat(timeout) * 1000;

        if (
            !name ||
            !id ||
            !type ||
            !host ||
            !Number.isFinite(portNumber) ||
            portNumber <= 0 ||
            portNumber > 65535 ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 0
        ) {
            return null;
        }

        return {
            id,
            name,
            type: type.toLowerCase() as MessageType,
            host,
            port: portNumber,
            timeout: timeoutMs,
        };
    }

    /**
     * Shuts the worker down and confirms it to the main thread.
     *
     * @remarks
     * `stopped` is posted from the socket's close callback so the main thread
     * learns of it only once the port is really released, and unconditionally
     * if there is no socket to close.
     */
    private stop(): void {
        this.cleanup();

        if (this.socket) {
            this.socket.close(() => {
                this.messagePort.postMessage({ type: 'stopped' });
            });

            return;
        }

        this.messagePort.postMessage({ type: 'stopped' });
    }

    /**
     * Drops known servers and stops taking new announcements.
     *
     * @remarks
     * The socket's `error` listener is deliberately left attached: a failure
     * raised while closing must not surface as an unhandled `error` event and
     * take the worker down on its way out.
     */
    private cleanup(): void {
        this.servers.clear();

        if (this.socket) {
            // keep the 'error' listener attached: a socket error during
            // close must not crash the worker as an unhandled 'error' event
            this.socket.removeAllListeners('message');
        }
    }
}

// this module doubles as the worker thread's entry point: loading it in a
// worker starts the listener, while loading it on the main thread (as the type
// imports above do) defines the class and does nothing else
if (!isMainThread && parentPort) {
    new UDPWorker(workerData, parentPort);
}
