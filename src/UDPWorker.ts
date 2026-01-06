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
import { UDPClusterManagerOptions } from './UDPClusterManager';
import { uuid } from './uuid';

process.setMaxListeners(10000);

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

class UDPWorker {
    private readonly socket: Socket;
    private readonly servers = new Map<string, string>();

    constructor(
        private readonly options: UDPClusterManagerOptions,
        private readonly messagePort: MessagePort,
    ) {
        this.setupMessageHandlers();
        this.setupProcessHandlers();
        this.socket = createSocket({
            type: 'udp4',
            reuseAddr: true,
            reusePort: true,
        }).bind(this.options.port, this.selectNetworkInterface());
        this.socket.on(
            'message',
            message => this.processMessage(this.parseMessage(message)),
        );
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

    private setupProcessHandlers(): void {
        process.on('SIGTERM', this.cleanup);
        process.on('SIGINT', this.cleanup);
        process.on('SIGABRT', this.cleanup);
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
        const stamp = uuid();
        const correction = this.options.aliveTimeoutCorrection ?? 0;
        const effectiveTimeout = message.timeout + correction + 1;
        const key = UDPWorker.getServerKey(message);

        this.servers.set(key, stamp);

        const t: any = setTimeout(() => setImmediate(() => {
            if (this.servers.get(key) === stamp) {
                this.removeServer(message);
            }
        }), effectiveTimeout);
        // Avoid keeping the event loop alive due to pending timers
        try {
            if (t && typeof t.unref === 'function') {
                t.unref();
            }
        } catch {/* ignore */}
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
        const broadcastAddress = this.options.address
            || this.options.limitedAddress;
        const defaultAddress = '0.0.0.0';

        if (
            !broadcastAddress
            || broadcastAddress === this.options.limitedAddress
        ) {
            return defaultAddress;
        }

        for (const key in interfaces) {
            if (!interfaces[key]) {
                continue;
            }

            for (const net of interfaces[key]) {
                const shouldBeSelected = net.family === 'IPv4'
                    && net.address.startsWith(
                        broadcastAddress.replace(/\.255/g, ''),
                    );

                if (shouldBeSelected) {
                    return net.address;
                }
            }
        }

        return defaultAddress;
    }

    private parseMessage(input: Buffer): Message {
        const [
            name,
            id,
            type,
            address = '',
            timeout = '0',
        ] = input.toString().split('\t');
        const [host, port] = address.split(':');

        return {
            id,
            name,
            type: type.toLowerCase() as MessageType,
            host,
            port: parseInt(port),
            timeout: parseFloat(timeout) * 1000,
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
            this.socket.removeAllListeners();
        }
    }
}

if (!isMainThread && parentPort) {
    new UDPWorker(workerData, parentPort);
}
