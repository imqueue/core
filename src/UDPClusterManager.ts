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
import {
    IMessageQueueConnection,
} from './IMessageQueue';
import { ICluster, ClusterManager } from './ClusterManager';
import { Socket, createSocket } from 'dgram';
import { networkInterfaces } from 'os';

enum BroadcastedMessageType {
    Up = 'up',
    Down = 'down',
}

interface BroadcastedMessage {
    name: string;
    id: string;
    type: BroadcastedMessageType;
    host: string;
    port: number;
    timeout: number;
}

interface ClusterServer extends IMessageQueueConnection {
    timeout?: number;
    timestamp?: number;
    timer?: NodeJS.Timeout;
}

export const DEFAULT_UDP_BROADCAST_CLUSTER_MANAGER_OPTIONS = {
    broadcastPort: 63000,
    broadcastAddress: '255.255.255.255',
    aliveTimeoutCorrection: 1000,
};

export interface UDPClusterManagerOptions {
    /**
     * Represents the cluster operations that are responsible for managing
     * clusters. This includes operations such as adding, removing, or checking
     * if a cluster server exists.
     *
     * @type {ICluster}
     */
    cluster?: ICluster;

    /**
     * Message queue broadcast port
     *
     * @default 63000
     * @type {number}
     */
    broadcastPort?: number;

    /**
     * Message queue broadcast address
     *
     * @default limitedBroadcastAddress
     * @type {number}
     */
    broadcastAddress?: string;

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
    aliveTimeoutCorrection?: number;

    /**
     * Skip messages that are broadcast by specified addresses or set to
     * "localhost" if you want to skip messages from "127.0.0.1" or "::1"
     *
     * @type {"local" | string[]}
     */
    excludeHosts?: 'localhost' | string[];

    /**
     * Allow messages that are broadcast only by specified addresses or set to
     * "localhost" if you want to allow messages only from "127.0.0.1" or "::1"
     *
     * @type {"local" | string[]}
     */
    includeHosts?: 'localhost' | string[];
}

const LOCALHOST_ADDRESSES = [
    'localhost',
    '127.0.0.1',
    '::1',
];

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

    constructor(options?: UDPClusterManagerOptions) {
        super();

        this.options = {
            ...DEFAULT_UDP_BROADCAST_CLUSTER_MANAGER_OPTIONS,
            ...options || {},
        };
        this.startListening(this.options);
    }

    private listenBroadcastedMessages(
        listener: (message: BroadcastedMessage) => void,
        options: UDPClusterManagerOptions,
    ): void {
        const address = UDPClusterManager.selectNetworkInterface(
            options,
        );
        const key = `${ address }:${ options.broadcastPort }`;

        if (!UDPClusterManager.sockets[key]) {
            const socket = createSocket({ type: 'udp4', reuseAddr: true });

            socket.bind(options.broadcastPort, address);
            UDPClusterManager.sockets[key] = socket;
        }

        UDPClusterManager.sockets[key].on(
            'message',
            message => listener(
                UDPClusterManager.parseBroadcastedMessage(message),
            ),
        );
    }

    private startListening(
        options: UDPClusterManagerOptions = {},
    ): void {
        this.listenBroadcastedMessages(
            UDPClusterManager.processBroadcastedMessage(this),
            options,
        );
    }

    private static verifyHosts(
        host: string,
        hosts: string[] | 'localhost',
    ): boolean {
        const normalizedHosts = hosts === 'localhost'
            ? LOCALHOST_ADDRESSES
            : hosts
        ;

        return normalizedHosts.includes(host);
    }

    private static processMessageOnCluster(
        cluster: ICluster,
        message: BroadcastedMessage,
        aliveTimeoutCorrection?: number,
    ): void {
        const server = cluster.find<ClusterServer>(message);

        if (server && message.type === BroadcastedMessageType.Down) {
            clearTimeout(server.timer);

            return cluster.remove(message);
        }

        if (!server && message.type === BroadcastedMessageType.Up) {
            cluster.add(message);

            const added = cluster.find<ClusterServer>(message);

            if (added) {
                UDPClusterManager.serverAliveWait(
                    cluster,
                    added,
                    aliveTimeoutCorrection,
                );
            }

            return;
        }

        if (server && message.type === BroadcastedMessageType.Up) {
            return UDPClusterManager.serverAliveWait(
                cluster,
                server,
                aliveTimeoutCorrection,
                message,
            );
        }
    }

    private static processBroadcastedMessage(
        context: UDPClusterManager,
    ): (message: BroadcastedMessage) => void {
        return message => {
            if (
                context.options.excludeHosts
                && UDPClusterManager.verifyHosts(
                    message.host,
                    context.options.excludeHosts,
                )
            ) {
                 return ;
            }

            if (
                context.options.includeHosts
                && !UDPClusterManager.verifyHosts(
                    message.host,
                    context.options.includeHosts,
                )
            ) {
                 return ;
            }

            for (const cluster of context.clusters) {
                UDPClusterManager.processMessageOnCluster(
                    cluster,
                    message,
                    context.options.aliveTimeoutCorrection,
                );
            }
        };
    }

    private static parseBroadcastedMessage(
        input: Buffer,
    ): BroadcastedMessage {
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
            type: type.toLowerCase() as BroadcastedMessageType,
            host,
            port: parseInt(port),
            timeout: parseFloat(timeout) * 1000,
        };
    }

    private static serverAliveWait(
        cluster: ICluster,
        server: ClusterServer,
        aliveTimeoutCorrection?: number,
        message?: BroadcastedMessage,
    ): void {
        clearTimeout(server.timer);
        server.timestamp = Date.now();

        if (message) {
            server.timeout = message.timeout;
        }

        const correction = aliveTimeoutCorrection || 0;
        const timeout = (server.timeout || 0) + correction;

        server.timer = setTimeout(() => {
            const existing = cluster.find<ClusterServer>(server);

            if (!existing) {
                return;
            }

            const now = Date.now();
            const delta = now - (existing.timestamp || now);
            const currentTimeout = (existing.timeout || 0) + correction;

            if (delta >= currentTimeout) {
                clearTimeout(server.timer);

                cluster.remove(server);
            }
        }, timeout);
    }

    /**
     * Destroys the UDPClusterManager by closing all opened network connections
     * and safely destroying all blocking sockets
     *
     * @returns {Promise<void>}
     * @throws {Error}
     */
    public async destroy(): Promise<void> {
        // Close all UDP sockets and clean up connections
        const socketKeys = Object.keys(UDPClusterManager.sockets);
        const closePromises: Promise<void>[] = [];

        for (const key of socketKeys) {
            const socket = UDPClusterManager.sockets[key];

            if (socket) {
                closePromises.push(new Promise<void>(((socketKey: string): any =>
                    ((resolve: any, reject: any): any => {
                        try {
                            // Check if socket has close method and is not already closed
                            if (typeof socket.close === 'function') {
                                // Remove all event listeners to prevent memory leaks
                                socket.removeAllListeners();

                                // Close the socket
                                socket.close(() => {
                                    socket.unref();
                                    delete UDPClusterManager.sockets[socketKey];
                                    resolve();
                                });
                            } else {
                                resolve();
                            }
                        } catch (error) {
                            // Handle any errors during socket closure gracefully
                            reject(error as Error);
                        }
                    }) as any)(key)));
            }
        }

        // Wait for all sockets to close
        await Promise.all(closePromises);

        // Clear the static sockets record
        UDPClusterManager.sockets = {};
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

        if (!broadcastAddress) {
            return defaultAddress;
        }

        const equalAddresses = broadcastAddress === limitedBroadcastAddress;

        if (equalAddresses) {
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
