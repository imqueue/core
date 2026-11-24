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
 * A TCP proxy in front of a real broker that can be frozen: from then on its
 * connections stay open and nothing crosses them in either direction - a
 * broker that hangs, or is cut off, as its clients see it.
 *
 * A proxy rather than pausing the broker itself, because the integration
 * specs share one broker and run concurrently: `CLIENT PAUSE` or pausing its
 * container would stall every other spec too. Only the connections made
 * through the proxy are affected.
 */
import {
    type AddressInfo,
    createConnection,
    createServer,
    type Socket,
} from 'node:net';

/** A running proxy. */
export interface FreezingProxy {
    /** Port the proxy listens on, on 127.0.0.1. */
    port: number;
    /** Stops forwarding on every connection, open and future, for good. */
    freeze(): void;
    /** Drops every connection and stops listening. */
    close(): Promise<void>;
}

/**
 * Starts a proxy forwarding to the given broker.
 *
 * @param host - the broker's host
 * @param port - the broker's port
 * @returns the running proxy, listening on a port picked at run time
 */
export async function startFreezingProxy(
    host: string,
    port: number,
): Promise<FreezingProxy> {
    const sockets = new Set<Socket>();
    let frozen = false;

    const hold = (socket: Socket): void => {
        socket.unpipe();
        socket.pause();
    };

    const server = createServer(client => {
        const upstream = createConnection({ host, port });

        for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            // a frozen peer is torn down by its own client at teardown
            socket.on('error', () => undefined);
        }

        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());

        if (frozen) {
            hold(client);
            hold(upstream);

            return;
        }

        client.pipe(upstream);
        upstream.pipe(client);
    });

    await new Promise<void>(resolve =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );

    return {
        port: (server.address() as AddressInfo).port,
        freeze() {
            frozen = true;

            for (const socket of sockets) {
                hold(socket);
            }
        },
        close() {
            for (const socket of sockets) {
                socket.destroy();
            }

            return new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
