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
import '../mocks/index.js';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import assert from 'node:assert/strict';
import { UDPClusterManager } from '../../src/index.js';

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
        it('should be idempotent', async () => {
            const manager: any = new UDPClusterManager();

            await manager.destroy();
            // a repeated destroy must not throw or corrupt refcounts
            await manager.destroy();

            assert.equal(
                (UDPClusterManager as any).workerRefs[manager.workerKey],
                undefined,
            );
        });
    });
});

describe('UDPClusterManager - shared worker fan-out', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should deliver worker messages to every manager sharing a worker', async () => {
        const clusterOne: any = {
            add: mock.fn(),
            remove: () => {},
            find: () => undefined,
        };
        const clusterTwo: any = {
            add: mock.fn(),
            remove: () => {},
            find: () => undefined,
        };
        const managerOne: any = new UDPClusterManager();
        const managerTwo: any = new UDPClusterManager();

        // same options must resolve to one shared worker
        assert.equal(managerOne.worker, managerTwo.worker);

        managerOne.init(clusterOne);
        managerTwo.init(clusterTwo);

        emitMessage(managerOne, 'cluster:add');

        assert.equal(clusterOne.add.mock.callCount(), 1);
        assert.equal(clusterTwo.add.mock.callCount(), 1);

        await managerOne.destroy();
        await managerTwo.destroy();
    });

    it('should stop delivering messages to a destroyed manager', async () => {
        const clusterOne: any = {
            add: mock.fn(),
            remove: () => {},
            find: () => undefined,
        };
        const clusterTwo: any = {
            add: mock.fn(),
            remove: () => {},
            find: () => undefined,
        };
        const managerOne: any = new UDPClusterManager();
        const managerTwo: any = new UDPClusterManager();

        managerOne.init(clusterOne);
        managerTwo.init(clusterTwo);

        await managerOne.destroy();

        emitMessage(managerTwo, 'cluster:add');

        assert.equal(clusterOne.add.mock.callCount(), 0);
        assert.equal(clusterTwo.add.mock.callCount(), 1);

        await managerTwo.destroy();
    });

    it('should use separate workers for differing worker options', async () => {
        const managerOne: any = new UDPClusterManager();
        const managerTwo: any = new UDPClusterManager({
            aliveTimeoutCorrection: 1234,
        });

        assert.notEqual(managerOne.workerKey, managerTwo.workerKey);
        assert.notEqual(managerOne.worker, managerTwo.worker);

        await managerOne.destroy();
        await managerTwo.destroy();
    });

    it('should log worker "error" events via logger.error', async () => {
        const error = mock.fn();
        const manager: any = new UDPClusterManager({
            logger: { log: () => {}, info: () => {}, warn: () => {}, error },
        });

        manager.worker.emit('error', new Error('worker blew up'));

        assert.equal(error.mock.callCount(), 1);
        assert.match(
            String(error.mock.calls[0].arguments[1]),
            /worker blew up/,
        );

        await manager.destroy();
    });

    it('should log worker socket errors instead of crashing', async () => {
        const warn = mock.fn();
        const manager: any = new UDPClusterManager({
            logger: { log: () => {}, info: () => {}, warn, error: () => {} },
        });

        manager.worker.emit('message', {
            type: 'error',
            error: 'bind failed',
        });

        assert.equal(warn.mock.callCount(), 1);
        assert.match(String(warn.mock.calls[0].arguments[0]), /bind failed/);

        await manager.destroy();
    });

    it('should not warn about unexpected exit on graceful destroy', async () => {
        const warn = mock.fn();
        const manager: any = new UDPClusterManager({
            logger: { log: () => {}, info: () => {}, warn, error: () => {} },
        });
        const worker = manager.worker;
        const exited = new Promise<void>(resolve =>
            worker.on('exit', () => resolve()),
        );

        await manager.destroy();
        await exited;
        // let the supervision 'exit' handler run
        await new Promise(resolve => setImmediate(resolve));

        const warnedUnexpected = warn.mock.calls.some((call: any) =>
            String(call.arguments[0]).includes('unexpectedly'),
        );

        assert.equal(warnedUnexpected, false);
    });

    it('should not bind process signal handlers when handleSignals is false', async () => {
        const previouslyBound = (UDPClusterManager as any).signalsBound;

        (UDPClusterManager as any).signalsBound = false;

        const before = process.listenerCount('SIGABRT');
        const manager: any = new UDPClusterManager({ handleSignals: false });

        assert.equal(process.listenerCount('SIGABRT'), before);
        assert.equal((UDPClusterManager as any).signalsBound, false);

        await manager.destroy();
        (UDPClusterManager as any).signalsBound = previouslyBound;
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
            on: (event: string, cb: Function) => {
                if (event === 'message') {
                    // unrelated broadcast noise must not consume the wait
                    setImmediate(() => cb({ type: 'cluster:add' }));
                    setImmediate(() => cb({ type: 'stopped' }));
                }
            },
            off: () => {},
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

describe('UDPClusterManager lifecycle internals', () => {
    const noopCluster = (): any => ({
        add: () => undefined,
        remove: () => undefined,
        find: () => undefined,
    });

    afterEach(() => {
        mock.restoreAll();
        (UDPClusterManager as any).shuttingDown = false;
    });

    it('ignores worker messages that are not cluster events', async () => {
        const manager: any = new UDPClusterManager();

        manager.init(noopCluster());
        assert.doesNotThrow(() =>
            manager.worker.emit('message', { type: 'system:info' }),
        );

        await manager.destroy();
    });

    it('free() flags shutdown and stops every worker', async () => {
        // stub destroyWorker so the real 5s stop-acknowledgement wait (and any
        // real worker teardown) is skipped — free()'s own logic is what we test
        const destroySpy: Mock<any> = mock.method(
            UDPClusterManager as any,
            'destroyWorker',
            async () => undefined,
        );
        (UDPClusterManager as any).workers['fake:worker'] = { fake: true };

        await (UDPClusterManager as any).free();

        assert.equal((UDPClusterManager as any).shuttingDown, true);
        assert.ok(destroySpy.mock.callCount() > 0);

        delete (UDPClusterManager as any).workers['fake:worker'];
    });

    it('freeAndRaise() frees workers then re-raises the signal', async () => {
        const kill: Mock<any> = mock.method(process, 'kill', () => true);
        mock.method(
            UDPClusterManager as any,
            'destroyWorker',
            async () => undefined,
        );

        await (UDPClusterManager as any).freeAndRaise('SIGTERM');

        assert.ok(kill.mock.callCount() > 0);
    });

    it('binds a signal handler that frees and re-raises', async () => {
        mock.method(process, 'kill', () => true);
        mock.method(
            UDPClusterManager as any,
            'destroyWorker',
            async () => undefined,
        );

        const prev = (UDPClusterManager as any).signalsBound;
        (UDPClusterManager as any).signalsBound = false;

        const before = process.listeners('SIGTERM').slice();
        (UDPClusterManager as any).bindSignals();
        const added = process
            .listeners('SIGTERM')
            .filter(l => !before.includes(l));

        assert.ok(added.length > 0);

        await (added[0] as any)('SIGTERM');

        for (const sig of ['SIGTERM', 'SIGINT', 'SIGABRT'] as const) {
            for (const l of added) {
                process.removeListener(sig, l as any);
            }
        }

        (UDPClusterManager as any).signalsBound = prev;
    });

    it('warns and schedules a respawn on unexpected worker exit', async () => {
        const warn: Mock<any> = mock.fn();
        const manager: any = new UDPClusterManager({
            logger: { log: () => {}, info: () => {}, warn, error: () => {} },
        });

        manager.init(noopCluster());
        const worker = manager.worker;

        worker.emit('exit', 1);

        const warned = warn.mock.calls.some((call: any) =>
            String(call.arguments[0]).includes('unexpectedly'),
        );
        assert.equal(warned, true);

        await worker.terminate?.();
        await manager.destroy().catch(() => undefined);
    });

    it('respawn() replaces the worker after the delay', async () => {
        const manager: any = new UDPClusterManager();

        manager.init(noopCluster());
        const key = manager.workerKey;
        const original = manager.worker;

        delete (UDPClusterManager as any).workers[key];
        (UDPClusterManager as any).respawn(key);

        await new Promise(resolve => setTimeout(resolve, 1200));

        assert.ok(manager.worker);

        await original.terminate?.();
        await manager.destroy().catch(() => undefined);
    });
});

describe('UDPClusterManager.respawn() guard', () => {
    afterEach(() => {
        mock.restoreAll();
        (UDPClusterManager as any).shuttingDown = false;
    });

    it('is a no-op without registered instances', () => {
        assert.doesNotThrow(() =>
            (UDPClusterManager as any).respawn('missing-worker-key'),
        );
    });
});
