/*!
 * UDP message listener for cluster managing
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
import { IMessageQueueConnection } from './IMessageQueue';
import { ClusterManager, ICluster } from './ClusterManager';
import { createSocket, Socket } from 'dgram';
import { networkInterfaces } from 'os';

enum MessageType {
    Up = 'up',
    Down = 'down',
}

interface Message {
    name: string;
    id: string;
    type: MessageType;
    host: string;
    port: number;
    timeout: number;
}

interface ClusterServer extends IMessageQueueConnection {
    timeout?: number;
    timestamp?: number;
    timer?: any;
}

export const DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS = {
    broadcastPort: 63000,
    broadcastAddress: '255.255.255.255',
    aliveTimeoutCorrection: 1000,
};

export interface UDPClusterManagerOptions {
    /**
     * Message queue broadcast port
     *
     * @default 63000
     * @type {number}
     */
    broadcastPort: number;

    /**
     * Message queue broadcast address
     *
     * @default limitedBroadcastAddress
     * @type {number}
     */
    broadcastAddress: string;

    /**
     * Message queue limited broadcast address
     *
     * @default 255.255.255.255
     * @type {string}
     */
    limitedBroadcastAddress?: string;

    /**
     * Message queue alive timeout correction. Used to correct waiting time to
     * check if the server is alive
     *
     * @default 1000
     * @type {number}
     */
    aliveTimeoutCorrection: number;
}

/**
 * UDP broadcast-based cluster management implementation
 *
 * @example
 * ~~~typescript
 * const queue = new ClusteredRedisQueue('ClusteredQueue', {
 *     clusterManagers: [new UDPBroadcastClusterManager()],
 * });
 * ~~~
 */
export class UDPClusterManager extends ClusterManager {
    private static sockets: Record<string, Socket> = {};
    private readonly options: UDPClusterManagerOptions;
    private socketKey: string;

    private get socket(): Socket | undefined {
        return UDPClusterManager.sockets[this.socketKey];
    }

    private set socket(socket: Socket) {
        UDPClusterManager.sockets[this.socketKey] = socket;
    }

    constructor(options?: Partial<UDPClusterManagerOptions>) {
        super();

        this.options = {
            ...DEFAULT_UDP_CLUSTER_MANAGER_OPTIONS,
            ...options || {},
        };
        this.startListening();

        process.on('SIGTERM', UDPClusterManager.free);
        process.on('SIGINT', UDPClusterManager.free);
        process.on('SIGABRT', UDPClusterManager.free);
    }

    private static async free(): Promise<void> {
        const socketKeys = Object.keys(UDPClusterManager.sockets);

        await Promise.all(socketKeys.map(
            socketKey => UDPClusterManager.destroySocket(
                socketKey,
                UDPClusterManager.sockets[socketKey],
            )),
        );
    }

    private listenBroadcastedMessages(
        listener: (message: Message) => void,
        options: UDPClusterManagerOptions,
    ): void {
        const address = UDPClusterManager.selectNetworkInterface(options);

        this.socketKey = `${ address }:${ options.broadcastPort }`;

        if (!this.socket) {
            this.socket = createSocket({
                type: 'udp4',
                reuseAddr: true,
                reusePort: true,
            }).bind(options.broadcastPort, address);
        }

        this.socket.on(
            'message',
            message => {
                listener(
                    UDPClusterManager.parseBroadcastedMessage(message),
                );
            },
        );
    }

    private startListening(): void {
        this.listenBroadcastedMessages(
            message => {
                this.anyCluster(cluster => {
                    UDPClusterManager.processMessageOnCluster(
                        cluster,
                        message,
                        this.options.aliveTimeoutCorrection,
                    );
                }).then();
            },
            this.options,
        );
    }

    private static processMessageOnCluster(
        cluster: ICluster,
        message: Message,
        aliveTimeoutCorrection: number,
    ): void {
        const server = cluster.find<ClusterServer>(message);

        if (server && message.type === MessageType.Down) {
            return cluster.remove(message);
        }

        if (!server && message.type === MessageType.Up) {
            return UDPClusterManager.serverAliveWait(
                cluster,
                cluster.add<ClusterServer>(message),
                message,
                aliveTimeoutCorrection,
                false,
            );
        }

        if (server && message.type === MessageType.Up) {
            UDPClusterManager.serverAliveWait(
                cluster,
                server,
                message,
                aliveTimeoutCorrection,
            );
        }
    }

    private static parseBroadcastedMessage(input: Buffer): Message {
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

    private static serverAliveWait(
        cluster: ICluster,
        server: ClusterServer,
        message: Message,
        aliveTimeoutCorrection: number,
        existingServer: boolean = true,
    ): void {
        if (server.timer === undefined && existingServer) {
            return;
        }

        clearTimeout(server.timer);

        server.timer = undefined;
        server.timestamp = Date.now();
        server.timeout = message.timeout || 0;
        server.timer = setTimeout(() => {
            const existing = cluster.find<ClusterServer>(server);

            if (!existing) {
                return;
            }

            const now = Date.now();
            const delta = now - (existing.timestamp || now);
            const currentTimeout = (existing.timeout || 0) +
                aliveTimeoutCorrection;

            if (delta >= currentTimeout) {
                cluster.remove(server);
            }
        }, server.timeout + aliveTimeoutCorrection);
    }

    /**
     * Destroys the UDPClusterManager by closing all opened network connections
     * and safely destroying all blocking sockets
     *
     * @returns {Promise<void>}
     * @throws {Error}
     */
    public async destroy(): Promise<void> {
        await UDPClusterManager.destroySocket(this.socketKey, this.socket);
    }

    private static async destroySocket(
        socketKey: string,
        socket?: Socket,
    ): Promise<void> {
        if (!socket) {
            return;
        }

        return await new Promise((resolve, reject) => {
            try {
                if (typeof socket.close !== 'function') {
                    resolve();

                    return;
                }

                socket.removeAllListeners();
                socket.close(() => {
                    if (socket && typeof (socket as any).unref === 'function') {
                        socket.unref();
                    }

                    if (
                        socketKey
                        && UDPClusterManager.sockets[socketKey]
                    ) {
                        delete UDPClusterManager.sockets[socketKey];
                    }

                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    private static selectNetworkInterface(
        options: Pick<
            UDPClusterManagerOptions,
            'broadcastAddress'
            | 'limitedBroadcastAddress'
        >,
    ): string {
        const interfaces = networkInterfaces();
        const limitedBroadcastAddress = options.limitedBroadcastAddress;
        const broadcastAddress = options.broadcastAddress
            || limitedBroadcastAddress;
        const defaultAddress = '0.0.0.0';

        if (!broadcastAddress || broadcastAddress === limitedBroadcastAddress) {
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
}
