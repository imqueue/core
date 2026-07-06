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
} from 'worker_threads';
import { createSocket, Socket } from 'dgram';
import { networkInterfaces } from 'os';
import { UDPWorkerOptions } from './UDPClusterManager';
import { randomUUID } from 'crypto';

enum MessageType {
    Up = 'up',
    Down = 'down',
}

interface Message {
    id: string;
    name: string;
    type: MessageType;
    host: string;
    port: number;
    timeout: number;
}

export class UDPWorker {
    private readonly socket: Socket;
    private readonly servers = new Map<string, string>();

    constructor(
        private readonly options: UDPWorkerOptions,
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

    private static getServerKey(message: Message): string {
        return message.id;
    }

    private setupMessageHandlers(): void {
        this.messagePort.on('message', message => {
            if (message.type === 'stop') {
                this.stop();
            }
        });
    }

    private addServer(message: Message): void {
        this.messagePort.postMessage({
            type: 'cluster:add',
            server: UDPWorker.mapMessage(message),
        });

        if (this.options.useAliveCheck) {
            this.serverAliveWait(message);
        }
    }

    private removeServer(message: Message): void {
        this.servers.delete(UDPWorker.getServerKey(message));
        this.messagePort.postMessage({
            type: 'cluster:remove',
            server: UDPWorker.mapMessage(message),
        });
    }

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

    private processMessage(message: Message): void {
        if (message.type === MessageType.Down) {
            return this.removeServer(message);
        }

        if (message.type === MessageType.Up) {
            return this.addServer(message);
        }
    }

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

    private cleanup(): void {
        this.servers.clear();

        if (this.socket) {
            // keep the 'error' listener attached: a socket error during
            // close must not crash the worker as an unhandled 'error' event
            this.socket.removeAllListeners('message');
        }
    }
}

if (!isMainThread && parentPort) {
    new UDPWorker(workerData, parentPort);
}
