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
 *
 * UDPClusterManager unit tests (merged: main suite, missing branches coverage
 * and destroyWorker() behavior).
 */
import '../mocks';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { UDPClusterManager } from '../../src';

const testMessageUp = {
    name: 'IMQUnitTest',
    id: '1234567890',
    type: 'up',
    address: '127.0.0.1:6379',
    timeout: 50,
};

const testMessageDown = {
    name: 'IMQUnitTest',
    id: '1234567890',
    type: 'down',
    address: '127.0.0.1:6379',
    timeout: 50,
};

const getSocket = (classObject: any) => {
    return classObject.worker;
};

const emitMessage = (
    instanceClass: any,
    type: 'cluster:add' | 'cluster:remove',
) => {
    getSocket(instanceClass).emit('message', {
        type,
        server: type === 'cluster:add' ? testMessageUp : testMessageDown,
    });
};

describe('UDPBroadcastClusterManager', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should be a class', () => {
        assert.equal(typeof UDPClusterManager, 'function');
    });

    it('should call add on cluster', async () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager();

        const add = mock.method(cluster, 'add');

        manager.init(cluster);

        emitMessage(manager, 'cluster:add');
        assert.equal(add.mock.callCount() > 0, true);
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

        const add = mock.method(cluster, 'add');

        manager.init(cluster);

        emitMessage(manager, 'cluster:add');
        assert.equal(add.mock.callCount() > 0, false);
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

        const remove = mock.method(cluster, 'remove');

        manager.init(cluster);

        emitMessage(manager, 'cluster:remove');
        assert.equal(remove.mock.callCount() > 0, true);
        await manager.destroy();
    });

    it('should handle server timeout and removal', (t, done) => {
        let addedServer: any = null;
        const cluster: any = {
            add: () => {},
            remove: async (server: any) => {
                assert.equal(server, addedServer);
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
        emitMessage(manager, 'cluster:add');

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
        emitMessage(manager, 'cluster:add');
        await manager.destroy();
    });

    describe('destroy()', () => {
        it('should handle empty sockets gracefully', async () => {
            const manager: any = new UDPClusterManager();

            // Clear any existing sockets
            (UDPClusterManager as any).sockets = {};

            // Should not throw when no sockets exist
            await manager.destroy();

            assert.equal(
                Object.keys((UDPClusterManager as any).sockets).length,
                0,
            );
        });
    });
});

describe('UDPClusterManager - cover remaining branches', () => {
    it('destroySocket should call socket.unref() when socket is present', async () => {
        // Prepare fake socket with unref
        const unref = mock.fn();
        const removeAll = mock.fn();
        const sock: any = {
            removeAllListeners: removeAll,
            close: (cb: (err?: any) => void) => cb(),
            unref,
        };
        const key = 'test-key';
        (UDPClusterManager as any).sockets[key] = sock;
        await (UDPClusterManager as any).destroySocket(key, sock);
        assert.equal(unref.mock.callCount() > 0, true);
        assert.equal((UDPClusterManager as any).sockets[key], undefined);
    });

    it('destroySocket should work when socket.unref() is absent (optional chaining negative branch)', async () => {
        const removeAll = mock.fn();
        const sock: any = {
            removeAllListeners: removeAll,
            close: (cb: (err?: any) => void) => cb(),
            // no unref method
        };
        const key = 'test-key-2';
        (UDPClusterManager as any).sockets[key] = sock;
        await (UDPClusterManager as any).destroySocket(key, sock);
        // should not throw, sockets map cleaned
        assert.equal((UDPClusterManager as any).sockets[key], undefined);
    });
});

describe('UDPClusterManager.destroyWorker()', () => {
    it('should resolve when worker is undefined (no-op)', async () => {
        const destroy = (UDPClusterManager as any).destroyWorker as Function;
        await destroy('0.0.0.0:63000', undefined);
    });

    it('should terminate worker and remove it from the workers map', async () => {
        const destroy = (UDPClusterManager as any).destroyWorker as Function;
        const workers = (UDPClusterManager as any).workers as Record<
            string,
            any
        >;
        const key = '1.2.3.4:65000';

        let terminated = false;
        const fakeWorker: any = {
            postMessage: () => {},
            once: (event: string, cb: Function) => {
                if (event === 'message') {
                    setImmediate(() => cb({ type: 'stopped' }));
                }
            },
            terminate: () => {
                terminated = true;
            },
        };

        workers[key] = fakeWorker;
        await destroy(key, fakeWorker);

        assert.equal(terminated, true);
        assert.equal(workers[key], undefined);
    });
});
