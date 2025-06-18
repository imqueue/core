/*!
 * Clustered messaging queue over Redis implementation
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

export interface UDPBroadcastClusterManagerOptions {
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
     * Indicates whether the network interface is internal (i.e., a loopback
     * interface) or external (i.e., connected to a network)
     *
     * @default false
     * @type {boolean}
     */
    internalNetworkInterface?: boolean;

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
export class UDPBroadcastClusterManager extends ClusterManager {
    private static socket: Socket;
    private readonly options: UDPBroadcastClusterManagerOptions;

    constructor(options?: UDPBroadcastClusterManagerOptions) {
        super();

        this.options = {
            ...DEFAULT_UDP_BROADCAST_CLUSTER_MANAGER_OPTIONS,
            ...options || {},
        };
        this.startListening(this.options);
    }

    private listenBroadcastedMessages(
        listener: (message: BroadcastedMessage) => void,
        options: UDPBroadcastClusterManagerOptions,
    ): void {
        if (!UDPBroadcastClusterManager.socket) {
            const socket = createSocket('udp4');
            const address = UDPBroadcastClusterManager.selectNetworkInterface(
                options,
            );

            socket.bind(options.broadcastPort, address);
            UDPBroadcastClusterManager.socket = socket;
        }

        UDPBroadcastClusterManager.socket.on(
            'message',
            message => listener(
                UDPBroadcastClusterManager.parseBroadcastedMessage(message),
            ),
        );
    }

    private startListening(
        options: UDPBroadcastClusterManagerOptions = {},
    ): void {
        this.listenBroadcastedMessages(
            UDPBroadcastClusterManager.processBroadcastedMessage(this),
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
                UDPBroadcastClusterManager.serverAliveWait(
                    cluster,
                    added,
                    aliveTimeoutCorrection,
                );
            }

            return;
        }

        if (server && message.type === BroadcastedMessageType.Up) {
            return UDPBroadcastClusterManager.serverAliveWait(
                cluster,
                server,
                aliveTimeoutCorrection,
                message,
            );
        }
    }

    private static processBroadcastedMessage(
        context: UDPBroadcastClusterManager,
    ): (message: BroadcastedMessage) => void {
        return message => {
            if (
                context.options.excludeHosts
                && UDPBroadcastClusterManager.verifyHosts(
                    message.host,
                    context.options.excludeHosts,
                )
            ) {
                 return ;
            }

            if (
                context.options.includeHosts
                && !UDPBroadcastClusterManager.verifyHosts(
                    message.host,
                    context.options.includeHosts,
                )
            ) {
                 return ;
            }

            for (const cluster of context.clusters) {
                UDPBroadcastClusterManager.processMessageOnCluster(
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

    private static selectNetworkInterface(
        options: Pick<
            UDPBroadcastClusterManagerOptions,
            'broadcastAddress'
            | 'limitedBroadcastAddress'
            | 'internalNetworkInterface'
        >,
    ): string {
        const interfaces = networkInterfaces();
        const limitedBroadcastAddress = options.limitedBroadcastAddress;
        const broadcastAddress = options.broadcastAddress
            || limitedBroadcastAddress;
        const internal = !!options.internalNetworkInterface;
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
                if (internal && !net.internal) {
                    continue;
                }

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
