/*!
 * ClusteredRedisQueue Unit Tests (core behavior + EventEmitter proxy methods,
 * addServerWithQueueInitializing, initializeQueue, and matchServers)
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
import { logger } from '../mocks/index.js';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClusteredRedisQueue, RedisQueue } from '../../src/index.js';
import { ClusterManager } from '../../src/ClusterManager.js';

process.setMaxListeners(100);

function assertDeepInclude(actual: any, subset: any): void {
    for (const key of Object.keys(subset)) {
        assert.deepEqual(actual[key], subset[key]);
    }
}

const clusterConfig = {
    logger,
    cluster: [
        {
            host: '127.0.0.1',
            port: 7777,
        },
        {
            host: '127.0.0.1',
            port: 8888,
        },
    ],
};

const server = { host: '127.0.0.1', port: 6380 };

// Access private static via casting
const match = (ClusteredRedisQueue as any).matchServers as (
    source: any,
    target: any,
    strict?: boolean,
) => boolean;

describe('ClusteredRedisQueue', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should be a class', () => {
        assert.equal(typeof ClusteredRedisQueue, 'function');
    });

    it('should implement IMessageQueue interface', () => {
        assert.equal(typeof ClusteredRedisQueue.prototype.start, 'function');
        assert.equal(typeof ClusteredRedisQueue.prototype.stop, 'function');
        assert.equal(typeof ClusteredRedisQueue.prototype.send, 'function');
        assert.equal(typeof ClusteredRedisQueue.prototype.destroy, 'function');
    });

    describe('constructor()', () => {
        it('should throw with improper options passed', () => {
            assert.throws(
                () => new ClusteredRedisQueue('TestClusteredQueue'),
                TypeError,
            );
        });

        it('should not throw if proper options passed', () => {
            assert.doesNotThrow(
                () =>
                    new ClusteredRedisQueue(
                        'TestClusteredQueue',
                        clusterConfig,
                    ),
            );
        });

        it('should initialize cluster manager', () => {
            const clusterManager = new (ClusterManager as any)();

            const init: Mock<any> = mock.method(clusterManager, 'init');

            new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
            });

            assert.equal(init.mock.callCount() > 0, true);
        });
    });

    describe('start()', () => {
        it('should start each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig,
            );

            cq.imqs.forEach((imq: any) => {
                mock.method(imq, 'start');
            });

            await cq.start();

            cq.imqs.forEach((imq: any) => {
                assert.equal(imq.start.mock.callCount() > 0, true);
            });

            await cq.destroy();
        });
    });

    describe('stop()', () => {
        it('should stop each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig,
            );

            cq.imqs.forEach((imq: any) => {
                mock.method(imq, 'stop');
            });

            await cq.stop();

            cq.imqs.forEach((imq: any) => {
                assert.equal(imq.stop.mock.callCount() > 0, true);
            });

            await cq.destroy();
        });
    });

    describe('send()', () => {
        it(
            'should balance send requests round-robin manner across nested ' +
                'queues',
            async () => {
                const cq: any = new ClusteredRedisQueue(
                    'TestClusteredQueue',
                    clusterConfig,
                );

                cq.imqs.forEach((imq: any) => {
                    mock.method(imq, 'send');
                });

                await cq.send('TestClusteredQueue', { hello: 'world' });

                assert.equal(cq.imqs[0].send.mock.callCount(), 1);
                assert.equal(cq.imqs[1].send.mock.callCount() > 0, false);

                await cq.send('TestClusteredQueue', { hello: 'world' });

                assert.equal(cq.imqs[0].send.mock.callCount(), 1);
                assert.equal(cq.imqs[1].send.mock.callCount(), 1);

                await cq.send('TestClusteredQueue', { hello: 'world' });

                assert.equal(cq.imqs[0].send.mock.callCount(), 2);
                assert.equal(cq.imqs[1].send.mock.callCount(), 1);

                await cq.destroy();
            },
        );

        it('should send message after queue was initialized', () => {
            return new Promise<void>(resolve => {
                const clusterManager = new (ClusterManager as any)();
                const cqOne: any = new ClusteredRedisQueue(
                    'TestClusteredQueueOne',
                    {
                        clusterManagers: [clusterManager],
                        logger,
                    },
                );
                const cqTwo: any = new ClusteredRedisQueue(
                    'TestClusteredQueueTwo',
                    {
                        clusterManagers: [clusterManager],
                        logger,
                    },
                );
                const message = { hello: 'world' };

                cqOne.start();
                cqTwo.start();

                cqTwo.on('message', () => {
                    cqOne.destroy();
                    cqTwo.destroy();

                    resolve();
                });

                cqOne.send('TestClusteredQueueTwo', message);
                cqTwo.addServer(clusterConfig.cluster[0]);
                cqOne.addServer(clusterConfig.cluster[0]);
            });
        });
    });

    describe('destroy()', () => {
        it('should destroy each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig,
            );

            cq.imqs.forEach((imq: any) => {
                mock.method(imq, 'destroy');
            });

            await cq.destroy();

            cq.imqs.forEach((imq: any) => {
                assert.equal(imq.destroy.mock.callCount() > 0, true);
            });
        });
    });

    describe('clear()', () => {
        it('should clear each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig,
            );

            cq.imqs.forEach((imq: any) => {
                mock.method(imq, 'clear');
            });

            await cq.clear();

            cq.imqs.forEach((imq: any) => {
                assert.equal(imq.clear.mock.callCount() > 0, true);
            });

            await cq.destroy();
        });
    });

    describe('subscribe()', () => {
        it('should subscribe after queue initialization', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
                logger,
            });
            const channel = 'TestChannel';

            cq.subscribe(channel, () => {});
            cq.addServer(clusterConfig.cluster[0]);

            assert.equal(cq.imqs[0].subscriptionName, channel);
        });
    });

    describe('addServer()', () => {
        it('should add cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
            });

            cq.addServer(clusterConfig.cluster[0]);

            assert.equal(cq.servers.length, 1);
        });

        it(
            'should call adding cluster server method through the' +
                ' Cluster Manager',
            () => {
                const clusterManager = new (ClusterManager as any)();
                const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                    clusterManagers: [clusterManager],
                });

                for (const server of clusterManager.clusters) {
                    server.add(clusterConfig.cluster[0]);
                }

                assert.equal(cq.servers.length, 1);
            },
        );
    });

    describe('removeServer()', () => {
        it('should remove cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
            });

            cq.addServer(clusterConfig.cluster[0]);
            cq.removeServer(clusterConfig.cluster[0]);

            assert.equal(cq.servers.length, 0);
        });

        it(
            'should call removing cluster server method through the' +
                ' Cluster Manager',
            () => {
                const clusterManager = new (ClusterManager as any)();
                const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                    clusterManagers: [clusterManager],
                });

                for (const server of clusterManager.clusters) {
                    server.remove(clusterConfig.cluster[0]);
                }

                assert.equal(cq.servers.length, 0);
            },
        );
    });

    describe('findServer()', () => {
        it('should find cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
            });

            cq.addServer(clusterConfig.cluster[0]);

            const server = cq.findServer(clusterConfig.cluster[0]);

            assertDeepInclude(server, clusterConfig.cluster[0]);
        });

        it(
            'should call find cluster server method through the' +
                ' Cluster Manager',
            () => {
                const clusterManager = new (ClusterManager as any)();
                const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                    clusterManagers: [clusterManager],
                });

                cq.addServer(clusterConfig.cluster[0]);

                for (const cluster of clusterManager.clusters) {
                    const server = cluster.find(clusterConfig.cluster[0]);

                    assertDeepInclude(server, clusterConfig.cluster[0]);
                }
            },
        );
    });
});

describe('ClusteredRedisQueue - EventEmitter proxy methods', () => {
    const clusterConfig = {
        cluster: [{ host: '127.0.0.1', port: 6379 }],
    };

    it('should cover rawListeners/getMaxListeners/eventNames/listenerCount/emit', async () => {
        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('ProxyQueue', {
            clusterManagers: [clusterManager],
        });

        // add underlying server and listener
        cq.addServer(clusterConfig.cluster[0]);
        const handler: Mock<any> = mock.fn();
        cq.imqs[0].on('test', handler);

        // set max listeners across emitters and verify getMaxListeners uses templateEmitter
        cq.setMaxListeners(20);
        assert.equal(cq.getMaxListeners(), 20);

        // collect raw listeners
        const raw = cq.rawListeners('test');
        assert.ok(raw.length > 0);

        // event names come from underlying imq
        const names = cq.eventNames();
        assert.ok(Array.isArray(names));
        assert.ok(names.map(String).includes('test'));

        // listener count is aggregated via templateEmitter method applied on imq[0]
        assert.equal(cq.listenerCount('test'), 1);

        // emit should return true
        assert.equal(cq.emit('test', 1, 2, 3), true);
        assert.equal(handler.mock.callCount(), 1);
    });

    it('should forward listener registration and removal to every queue', async () => {
        const cq: any = new ClusteredRedisQueue('ProxyFanout', {
            cluster: [
                { host: '127.0.0.1', port: 6379 },
                { host: '127.0.0.1', port: 6380 },
            ],
        });

        assert.equal(cq.imqs.length, 2);

        const handler: Mock<any> = mock.fn();

        // on() attaches the handler to each underlying queue
        cq.on('evt', handler);

        for (const imq of cq.imqs) {
            assert.equal(imq.listenerCount('evt'), 1);
        }

        // emit() reaches exactly the emitters where the listener is registered
        const fanout = cq.listeners('evt').length;
        cq.emit('evt', 'payload');
        assert.equal(handler.mock.callCount(), fanout);

        // addListener() attaches a second event on each queue
        cq.addListener('evt2', handler);

        for (const imq of cq.imqs) {
            assert.equal(imq.listenerCount('evt2'), 1);
        }

        // removeAllListeners() clears only the targeted event everywhere
        cq.removeAllListeners('evt');

        for (const imq of cq.imqs) {
            assert.equal(imq.listenerCount('evt'), 0);
            assert.equal(imq.listenerCount('evt2'), 1);
        }

        // removeListener()/off() detach from each queue
        cq.removeListener('evt2', handler);

        for (const imq of cq.imqs) {
            assert.equal(imq.listenerCount('evt2'), 0);
        }

        assert.equal(cq.listeners('evt2').length, 0);

        await cq.destroy();
    });

    it('should forward once/prepend variants with correct semantics', async () => {
        const cq: any = new ClusteredRedisQueue('ProxyOnce', {
            cluster: [{ host: '127.0.0.1', port: 6379 }],
        });
        const imq = cq.imqs[0];

        // once() is forwarded and auto-removed after a single emit
        cq.once('evt', mock.fn());
        assert.equal(imq.listenerCount('evt'), 1);
        cq.emit('evt');
        assert.equal(imq.listenerCount('evt'), 0);

        // prependListener() is forwarded and persists across emits
        cq.prependListener('evt', mock.fn());
        assert.equal(imq.listenerCount('evt'), 1);
        cq.emit('evt');
        cq.emit('evt');
        assert.equal(imq.listenerCount('evt'), 1);

        // prependOnceListener() is forwarded and auto-removed after one emit
        cq.prependOnceListener('evt2', mock.fn());
        assert.equal(imq.listenerCount('evt2'), 1);
        cq.emit('evt2');
        assert.equal(imq.listenerCount('evt2'), 0);

        // removeAllListeners() with no event clears every event everywhere
        cq.removeAllListeners();
        assert.equal(imq.listenerCount('evt'), 0);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue.addServerWithQueueInitializing() default param', () => {
    it('should use default initializeQueue=true when second param omitted', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Default', {
            logger: console,
            cluster: [{ host: '127.0.0.1', port: 6379 }],
        });
        // prevent any actual start/subscription side-effects
        (cq as any).state.started = false;
        (cq as any).state.subscription = null;

        const server = { host: '192.168.0.1', port: 6380 };
        const initializedSpy = new Promise<void>(resolve => {
            cq['clusterEmitter'].once('initialized', () => resolve());
        });

        // Call without the second argument to hit default "true" branch
        (cq as any).addServerWithQueueInitializing(server);

        await initializedSpy; // should emit initialized when default is true

        // Ensure the server added and queue length updated
        assert.equal(
            (cq as any).servers.some(
                (s: any) => s.host === server.host && s.port === server.port,
            ),
            true,
        );
        assert.equal((cq as any).imqLength, (cq as any).imqs.length);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue.addServerWithQueueInitializing(false)', () => {
    it('should add server without initializing queue and not emit initialized', async () => {
        const manager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('NoInit', {
            clusterManagers: [manager],
        });

        let initializedCalled = false;
        (cq as any).clusterEmitter.on('initialized', () => {
            initializedCalled = true;
        });

        // call private method via any to cover branch
        (cq as any).addServerWithQueueInitializing(server, false);

        // should have server and imq added
        assert.ok(cq.servers.length > 0);
        assert.ok(cq.imqs.length > 0);
        // queueLength updated
        assert.equal(cq.imqLength, cq.imqs.length);
        // initialized not emitted
        assert.equal(initializedCalled, false);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue.initializeQueue()', () => {
    it('should call imq.start when started and imq.subscribe when subscription is set', async () => {
        const startStub: Mock<any> = mock.method(
            RedisQueue.prototype as any,
            'start',
            async () => undefined,
        );
        const subscribeStub: Mock<any> = mock.method(
            RedisQueue.prototype as any,
            'subscribe',
            async () => undefined,
        );

        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('InitCover', {
            clusterManagers: [clusterManager],
        });

        // mark started and set subscription using public APIs
        await cq.start();
        const channel = 'X';
        const handler = () => undefined;
        await cq.subscribe(channel, handler);

        // adding a server triggers initializeQueue which should call start and subscribe
        cq.addServer({ host: '127.0.0.1', port: 6453 });

        // allow promises to resolve
        await new Promise(res => setTimeout(res, 0));

        assert.ok(startStub.mock.callCount() > 0);
        assert.ok(subscribeStub.mock.callCount() > 0);

        mock.restoreAll();
        await cq.destroy();
    });
});

describe('ClusteredRedisQueue.matchServers()', () => {
    it('should return sameAddress when no ids provided', () => {
        assert.equal(
            match({ host: 'h', port: 1 }, { host: 'h', port: 1 }),
            true,
        );
        assert.equal(
            match({ host: 'h', port: 1 }, { host: 'h', port: 2 }),
            false,
        );
    });

    it('should match servers if id provided', () => {
        assert.equal(
            match(
                { id: 'a', host: 'h', port: 1 },
                { id: 'a', host: 'h', port: 2 },
            ),
            true,
        );
        assert.equal(
            match(
                { id: 'a', host: 'h', port: 1 },
                { id: 'b', host: 'h', port: 1 },
            ),
            true,
        );
    });
});

describe('ClusteredRedisQueue fan-out helpers', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('selectQueue falls back to the start queue when none available', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Fallback', clusterConfig);

        cq.imqs.forEach((imq: any) => {
            Object.defineProperty(imq, 'available', {
                get: () => false,
                configurable: true,
            });
            mock.method(imq, 'send', async () => 'id');
        });

        await cq.send('CQ-Fallback', { a: 1 });

        assert.equal(cq.imqs[0].send.mock.callCount(), 1);

        await cq.destroy();
    });

    it('rejects send when no server becomes available in time', async () => {
        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('CQ-Timeout', {
            clusterManagers: [clusterManager],
            logger,
        });

        cq.sendInitTimeout = 20;

        await assert.rejects(
            cq.send('CQ-Timeout', { a: 1 }),
            /no cluster server became available/,
        );

        await cq.destroy();
    });

    it('queueLength() sums lengths across all queues', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Len', clusterConfig);

        mock.method(cq.imqs[0], 'queueLength', async () => 3);
        mock.method(cq.imqs[1], 'queueLength', async () => 4);

        assert.equal(await cq.queueLength(), 7);

        await cq.destroy();
    });

    it('logs through verbose() when the verbose option is enabled', async () => {
        const info: Mock<any> = mock.method(logger, 'info');
        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('CQ-Verbose', {
            clusterManagers: [clusterManager],
            logger,
            verbose: true,
        });

        assert.ok(info.mock.callCount() > 0);

        await cq.destroy();
    });

    it('off() detaches a listener from every queue', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Off', clusterConfig);
        const handler: Mock<any> = mock.fn();

        cq.on('evt', handler);
        cq.off('evt', handler);

        for (const imq of cq.imqs) {
            assert.equal(imq.listenerCount('evt'), 0);
        }

        await cq.destroy();
    });

    it('publish() forwards to every queue', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Pub', clusterConfig);

        cq.imqs.forEach((imq: any) =>
            mock.method(imq, 'publish', async () => undefined),
        );

        await cq.publish({ a: 1 }, 'target');

        for (const imq of cq.imqs) {
            assert.equal(imq.publish.mock.callCount(), 1);
        }

        await cq.destroy();
    });

    it('subscribe()/unsubscribe() forward to every queue', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Sub', clusterConfig);

        cq.imqs.forEach((imq: any) => {
            mock.method(imq, 'subscribe', async () => undefined);
            mock.method(imq, 'unsubscribe', async () => undefined);
        });

        await cq.subscribe('chan', () => undefined);
        await cq.unsubscribe();

        for (const imq of cq.imqs) {
            assert.equal(imq.subscribe.mock.callCount(), 1);
            assert.equal(imq.unsubscribe.mock.callCount(), 1);
        }

        await cq.destroy();
    });

    it('returns the existing server when adding a duplicate', async () => {
        const manager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('CQ-Existing', {
            clusterManagers: [manager],
        });

        const first = cq.addServerWithQueueInitializing(server, false);
        const second = cq.addServerWithQueueInitializing(server, false);

        assert.equal(second.host, first.host);
        assert.equal(second.port, first.port);
        assert.equal(cq.servers.length, 1);

        await cq.destroy();
    });
});
