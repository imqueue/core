/*!
 * RedisQueue Unit Tests
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
import { expect } from 'chai';
import { UDPClusterManager } from '../src';
import * as sinon from 'sinon';
import { Socket } from 'dgram';
import * as os from 'os';

const testMessageUp = 'name\tid\tup\taddress\ttimeout';
const testMessageDown = 'name\tid\tdown\taddress\ttimeout';

const getSocket = (classObject: typeof UDPClusterManager) => {
    return Object.values((classObject as any).sockets)[0] as Socket;
};

const emitMessage = (message: string) => {
    getSocket(UDPClusterManager).emit('message', Buffer.from(message));
};

describe('UDPBroadcastClusterManager', function() {
    this.timeout(5000);
    it('should be a class', () => {
        expect(typeof UDPClusterManager).to.equal('function');
    });

    it('should initialize socket if socket does not exists', async () => {
        const manager = new UDPClusterManager();
        expect(
            Object.values((UDPClusterManager as any).sockets),
        ).not.to.be.length(0);
        await manager.destroy();
    });

    it('should call add on cluster', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager();

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage(testMessageUp);
        expect(cluster.add.called).to.be.true;
        await manager.destroy();
    });

    it('should not call add on cluster if server exists', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {
                return {};
            },
        };
        const manager: any = new UDPClusterManager();

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage(testMessageUp);
        expect(cluster.add.called).to.be.false;
        await manager.destroy();
    });

    it('should call remove on cluster', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {
                return {};
            },
        };
        const manager: any = new UDPClusterManager();

        sinon.spy(cluster, 'remove');

        manager.init(cluster);

        emitMessage(testMessageDown);
        expect(cluster.remove.called).to.be.true;
        await manager.destroy();
    });

    it('should add server if localhost included', async () => {
       const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager({
            includeHosts: 'localhost',
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
        expect(cluster.add.called).to.be.true;
        await manager.destroy();
    });

    it('should not add server if localhost excluded', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager({
            excludeHosts: 'localhost',
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
        expect(cluster.add.called).to.be.false;
        await manager.destroy();
    });

    it('should not add server if not in includeHosts', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager({
            includeHosts: ['example.com'],
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
        expect(cluster.add.called).to.be.false;
        await manager.destroy();
    });

    it('should handle server timeout and removal', (done) => {
        let addedServer: any = null;
        const cluster: any = {
            add: () => {},
            remove: async (server: any) => {
                expect(server).to.equal(addedServer);
                await manager.destroy();
            },
            find: (message: any) => {
                if (!addedServer) {
                    addedServer = {
                        id: message.id,
                        timer: null,
                        timestamp: Date.now(),
                        timeout: 50, // Short timeout for test
                    };
                    return addedServer;
                }
                return addedServer;
            },
        };
        const manager: any = new UDPClusterManager();

        manager.init(cluster);

        // Send up message to add server with short timeout
        emitMessage('name\tid\tup\t127.0.0.1:6379\t0.05');

        // Wait for timeout to trigger removal
        setTimeout(async () => {
            await manager.destroy();
            done();
        }, 1000);
    });

    it('should handle timeout when server no longer exists', async () => {
        let serverAdded = false;
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: (message: any) => {
                if (!serverAdded) {
                    serverAdded = true;
                    return {
                        id: message.id,
                        timer: null,
                        timestamp: Date.now(),
                        timeout: 50,
                    };
                }
                // Return null to simulate server no longer existing
                return null;
            },
        };
        const manager: any = new UDPClusterManager();

        manager.init(cluster);

        // This should trigger the timeout handler that returns early (line 307)
        emitMessage('name\tid\tup\t127.0.0.1:6379\t0.05');
        await manager.destroy();
    });

    describe('destroy()', () => {
        it('should handle empty sockets gracefully', async () => {
            const cluster: any = {
                add: () => {},
                remove: () => {},
                find: () => {}
            };
            const manager: any = new UDPClusterManager();

            // Clear any existing sockets
            (UDPClusterManager as any).sockets = {};

            // Should not throw when no sockets exist
            await manager.destroy();

            expect(Object.keys((UDPClusterManager as any).sockets)).to.have.length(0);
        });
    });
});
