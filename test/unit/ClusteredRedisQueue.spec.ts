/*!
 * ClusteredRedisQueue Unit Tests (core behavior + EventEmitter proxy methods,
 * addServerWithQueueInitializing, syncHost, and matchServers)
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
import { describe, it, afterEach, mock, type Mock } from 'node:test';
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
        it('should subscribe after queue initialization', async () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue('TestClusteredQueue', {
                clusterManagers: [clusterManager],
                logger,
            });
            const channel = 'TestChannel';

            cq.subscribe(channel, () => {});
            cq.addServer(clusterConfig.cluster[0]);

            // addServer() documents the subscription as re-applied
            // asynchronously afterwards, so let that run settle
            await new Promise(resolve => setImmediate(resolve));

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
        (cq as any).state.channel = null;
        (cq as any).state.handlers = [];

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

describe('ClusteredRedisQueue.syncHost()', () => {
    it('should call imq.start when started and imq.subscribe for each handler', async () => {
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

        // adding a server starts its lifecycle and subscription catch-up
        cq.addServer({ host: '127.0.0.1', port: 6453 });

        // allow promises to resolve
        await new Promise(res => setTimeout(res, 0));

        assert.ok(startStub.mock.callCount() > 0);
        assert.ok(subscribeStub.mock.callCount() > 0);

        mock.restoreAll();
        await cq.destroy();
    });
});

describe('ClusteredRedisQueue handler catch-up', () => {
    afterEach(() => mock.restoreAll());

    const clusterOf = (): any =>
        new ClusteredRedisQueue('CatchUp', {
            cluster: [],
            logger,
        });
    const settled = (): Promise<void> =>
        new Promise(resolve => setImmediate(resolve));
    const deferred = () => Promise.withResolvers<void>();
    const first = (): void => undefined;
    const second = (): void => undefined;
    const third = (): void => undefined;

    // The fake records installed handlers at completion, just as RedisQueue.subscribe does.
    const hostOf = (cq: any): any => {
        const host = {
            redisKey: 'fake',
            subscriptionHandlers: [] as Array<(data: any) => void>,
            async subscribe(_channel: string, handler: (data: any) => void) {
                this.subscriptionHandlers.push(handler);
            },
            async unsubscribe() {
                this.subscriptionHandlers = [];
            },
            async destroy() {
                await this.unsubscribe();
            },
            async start() {},
        };
        cq.imqs.push(host);
        cq.imqLength = cq.imqs.length;
        return host;
    };

    it('rejects an empty channel name and a second channel, even with no hosts', async () => {
        const cq = clusterOf();
        await assert.rejects(cq.subscribe('', first), TypeError);
        await cq.subscribe('Events', first);
        await assert.rejects(cq.subscribe('Other', second), TypeError);
        assert.equal(cq.state.channel, 'Events');
        assert.deepEqual(cq.state.handlers, [first]);
        await cq.destroy();
    });

    it('gives a later-joining server every handler, each exactly once', async () => {
        const cq = clusterOf();
        await cq.subscribe('Events', first);
        await cq.subscribe('Events', second);
        const host = cq.addServer({ host: '127.0.0.1', port: 6601 }).imq;
        await settled();
        assert.deepEqual(host.subscriptionHandlers, [first, second]);
        await cq.destroy();
    });

    it('keeps two deliberate registrations of the same function', async () => {
        const cq = clusterOf();
        await cq.subscribe('Events', first);
        await cq.subscribe('Events', first);
        const host = cq.addServer({ host: '127.0.0.1', port: 6602 }).imq;
        await settled();
        assert.deepEqual(host.subscriptionHandlers, [first, first]);
        await cq.destroy();
    });

    it('counts only cluster installations when callers subscribe directly on a host', async () => {
        const cq = clusterOf();
        const host = cq.addServerWithQueueInitializing(
            { host: '127.0.0.1', port: 6610 },
            false,
        ).imq;
        await cq.subscribe('Events', first);
        await host.subscribe('Events', third);
        await cq.subscribe('Events', second);
        assert.deepEqual(host.subscriptionHandlers, [first, third, second]);
        await cq.syncHost(host);
        assert.deepEqual(host.subscriptionHandlers, [first, third, second]);
        await cq.destroy();
    });

    it('resets the cluster cursor when unsubscribe completes before replacement', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        await cq.subscribe('Events', first);
        await cq.unsubscribe();
        await cq.subscribe('Events', second);
        assert.deepEqual(host.subscriptionHandlers, [second]);
        await cq.destroy();
    });

    it('shares a pending start between deferred discovery and concurrent cluster starts', async () => {
        const cq = clusterOf();
        const gate = deferred();
        const start = mock.method(
            RedisQueue.prototype,
            'start',
            async function (this: RedisQueue) {
                await gate.promise;
                return this;
            },
        );
        cq.addServer({ host: '127.0.0.1', port: 6611 });
        const one = cq.start();
        const two = cq.start();
        try {
            await settled();
            assert.equal(start.mock.callCount(), 1);
        } finally {
            gate.resolve();
            await Promise.all([one, two]);
            await cq.destroy();
        }
    });

    for (const fails of [false, true]) {
        it(`releases pending startup after ${fails ? 'failure' : 'success'} so start can run again`, async () => {
            const cq = clusterOf();
            const host = hostOf(cq);
            let calls = 0;
            mock.method(host, 'start', async () => {
                if (++calls === 1 && fails) throw new Error('start refused');
            });
            if (fails) await assert.rejects(cq.start(), /start refused/);
            else await cq.start();
            await cq.start();
            assert.equal(calls, 2);
            await cq.destroy();
        });
    }

    it('starts a host added before start(), whatever the await depth between them', async () => {
        const started: any[] = [];

        mock.method(
            RedisQueue.prototype as any,
            'start',
            async function (this: any): Promise<void> {
                started.push(this);
            },
        );
        mock.method(
            RedisQueue.prototype as any,
            'subscribe',
            async () => undefined,
        );

        const cq = clusterOf();
        const joined = cq.addServer({ host: '127.0.0.1', port: 6801 }).imq;

        // the decision to start is taken when the run is created, but the run
        // is cached at once - so a start() arriving a microtask later used to
        // join a settled promise that had already decided not to start
        await Promise.resolve();

        await cq.start();
        await settled();

        assert.equal(
            started.includes(joined),
            true,
            'a host added before start() must still be started',
        );

        await cq.destroy();
    });

    it('clears the remembered subscription when the cluster is destroyed', async () => {
        const cq = clusterOf();

        await cq.subscribe('Events', () => undefined);
        await cq.destroy();

        assert.equal((cq as any).state.channel, null);
        assert.deepEqual((cq as any).state.handlers, []);
    });

    it('installs onto a joining host while its start is still stalled', async () => {
        let releaseStart: () => void = () => undefined;
        const starting = new Promise<void>(resolve => {
            releaseStart = resolve;
        });

        mock.method(
            RedisQueue.prototype as any,
            'start',
            async () => await starting,
        );

        const subscribeStub: Mock<any> = mock.method(
            RedisQueue.prototype as any,
            'subscribe',
            async () => undefined,
        );

        const cq = clusterOf();

        await cq.start();
        await cq.subscribe('Events', first);

        const joined = cq.addServer({ host: '127.0.0.1', port: 6802 }).imq;

        await settled();

        // no later subscribe() here: the handler must arrive through the
        // catch-up alone, which must not be sequenced behind a stalled start
        const onJoined = subscribeStub.mock.calls
            .filter((call: any) => call.this === joined)
            .map((call: any) => call.arguments);

        assert.deepEqual(onJoined, [['Events', first]]);

        releaseStart();
        await cq.destroy();
    });

    it('repeating catch-up installs nothing on an up-to-date host', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const sub = mock.method(host, 'subscribe');
        await cq.subscribe('Events', first);
        await cq.syncHost(host);
        await cq.syncHost(host);
        assert.equal(sub.mock.callCount(), 1);
        assert.deepEqual(host.subscriptionHandlers, [first]);
        await cq.destroy();
    });

    it('preserves a single live subscription without starting its host', async () => {
        const cq = clusterOf();
        const host = cq.addServerWithQueueInitializing(
            { host: '127.0.0.1', port: 6603 },
            false,
        ).imq;
        const start = mock.method(host, 'start', async () => {
            throw new Error('unavailable');
        });
        cq.state.started = true;
        const received: unknown[] = [];
        const handler = (data: unknown) => {
            received.push(data);
        };
        assert.equal(await cq.subscribe('Events', handler), undefined);
        assert.equal(start.mock.callCount(), 0);
        assert.deepEqual(host.subscriptionHandlers, [handler]);
        host.subscription.emit(
            'message',
            `${host.options.prefix}:Events`,
            '{"ok":true}',
        );
        assert.deepEqual(received, [{ ok: true }]);
        await cq.unsubscribe();
        assert.deepEqual(host.subscriptionHandlers, []);
        await cq.destroy();
    });

    for (const stalled of [false, true]) {
        it(`installs handlers independently of a ${stalled ? 'stalled' : 'failed'} joining start`, async () => {
            const cq = clusterOf();
            const gate = deferred();
            mock.method(
                RedisQueue.prototype,
                'start',
                async function (this: RedisQueue) {
                    if (stalled) {
                        await gate.promise;
                        return this;
                    }
                    throw new Error('unavailable');
                },
            );
            await cq.start();
            await cq.subscribe('Events', first);
            const host = cq.addServer({ host: '127.0.0.1', port: 6604 }).imq;
            try {
                // A stall must not even delay the live registration.
                await cq.subscribe('Events', second);
                assert.deepEqual(host.subscriptionHandlers, [first, second]);
            } finally {
                gate.resolve();
                await settled();
                await cq.destroy();
            }
        });
    }

    it('starts a joining host even when unsubscribe lands before catch-up', async () => {
        const cq = clusterOf();
        const start = mock.method(
            RedisQueue.prototype,
            'start',
            async function (this: RedisQueue) {
                return this;
            },
        );
        await cq.start();
        await cq.subscribe('Events', first);
        const host = cq.addServer({ host: '127.0.0.1', port: 6605 }).imq;
        await cq.unsubscribe();
        await settled();
        assert.ok(start.mock.calls.some(call => call.this === host));
        await cq.destroy();
    });

    it('does not start a joining host in a stopped cluster', async () => {
        const cq = clusterOf();
        const start = mock.method(
            RedisQueue.prototype,
            'start',
            async function (this: RedisQueue) {
                return this;
            },
        );
        cq.addServer({ host: '127.0.0.1', port: 6606 });
        await settled();
        assert.equal(start.mock.callCount(), 0);
        await cq.destroy();
    });

    it('does not start a host removed before its lifecycle run', async () => {
        const cq = clusterOf();
        const start = mock.method(
            RedisQueue.prototype,
            'start',
            async function (this: RedisQueue) {
                return this;
            },
        );
        await cq.start();
        const address = { host: '127.0.0.1', port: 6607 };
        cq.addServer(address);
        cq.removeServer(address);
        await settled();
        assert.equal(start.mock.callCount(), 0);
        await cq.destroy();
    });

    it('does not announce a removed host even with no subscriptions', async () => {
        const cq = clusterOf();
        const initialized = mock.fn();
        cq.clusterEmitter.on('initialized', initialized);
        const address = { host: '127.0.0.1', port: 6608 };
        cq.addServer(address);
        cq.removeServer(address);
        await settled();
        assert.equal(initialized.mock.callCount(), 0);
        await cq.destroy();
    });

    it('picks up a handler registered while a host is catching up', async () => {
        const cq = clusterOf();
        await cq.subscribe('Events', first);
        const host = hostOf(cq);
        const gate = deferred();
        const entered = deferred();
        const original = host.subscribe;
        mock.method(
            host,
            'subscribe',
            async function (this: any, channel: string, handler: typeof first) {
                if (handler === first) {
                    entered.resolve();
                    await gate.promise;
                }
                await original.call(this, channel, handler);
            },
        );
        const catchUp = cq.syncHost(host);
        await entered.promise;
        const live = cq.subscribe('Events', second);
        gate.resolve();
        await Promise.all([catchUp, live]);
        assert.deepEqual(host.subscriptionHandlers, [first, second]);
        await cq.destroy();
    });

    it('repairs a rejected chain and retries only the missing suffix', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        await cq.subscribe('Events', first);
        const boom = new Error('refused');
        const sub = mock.method(host, 'subscribe', async () => {
            throw boom;
        });
        await assert.rejects(
            cq.subscribe('Events', second),
            err => err === boom,
        );
        sub.mock.restore();
        await cq.subscribe('Events', third);
        assert.deepEqual(host.subscriptionHandlers, [first, second, third]);
        await cq.destroy();
    });

    it('rebuilds a known registration set after partial fan-out failure', async () => {
        const cq = clusterOf();
        const healthy = hostOf(cq);
        const failed = hostOf(cq);
        const sub = mock.method(failed, 'subscribe', async () => {
            throw new Error('refused');
        });
        await assert.rejects(cq.subscribe('Events', first), /refused/);
        assert.deepEqual(healthy.subscriptionHandlers, [first]);
        assert.deepEqual(
            cq.state.handlers,
            [first],
            'rejection does not roll back',
        );
        sub.mock.restore();
        await cq.unsubscribe();
        await cq.subscribe('Events', first);
        const joined = cq.addServer({ host: '127.0.0.1', port: 6609 }).imq;
        await settled();
        for (const host of [healthy, failed, joined]) {
            assert.deepEqual(host.subscriptionHandlers, [first]);
        }
        await cq.destroy();
    });

    it('stops installing on a removed host while the channel stays unchanged', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const gate = deferred();
        const entered = deferred();
        mock.method(
            host,
            'subscribe',
            async (_channel: string, handler: typeof first) => {
                if (handler === first) {
                    entered.resolve();
                    await gate.promise;
                }
                host.subscriptionHandlers.push(handler);
            },
        );
        cq.state.channel = 'Events';
        cq.state.handlers = [first, second];
        const run = cq.syncHost(host);
        await entered.promise;
        cq.imqs = [];
        gate.resolve();
        await run;
        assert.deepEqual(host.subscriptionHandlers, [first]);
        await cq.destroy();
    });

    it('stops an in-flight run when replacement handlers use a different channel', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const gate = deferred();
        const entered = deferred();
        const channels: string[] = [];
        const original = host.subscribe;
        mock.method(
            host,
            'subscribe',
            async function (this: any, channel: string, handler: typeof first) {
                channels.push(channel);
                if (handler === first) {
                    entered.resolve();
                    await gate.promise;
                }
                await original.call(this, channel, handler);
            },
        );
        const old = cq.subscribe('Old', first);
        await entered.promise;
        const clear = cq.unsubscribe();
        const newFirst = cq.subscribe('New', second);
        const newSecond = cq.subscribe('New', third);
        gate.resolve();
        await Promise.all([old, clear, newFirst, newSecond]);
        assert.deepEqual(channels, ['Old', 'New', 'New']);
        assert.deepEqual(host.subscriptionHandlers, [second, third]);
        await cq.destroy();
    });

    for (const inFlight of [false, true]) {
        it(`keeps replacement handlers after teardown with an ${inFlight ? 'in-flight' : 'unstarted'} run`, async () => {
            const cq = clusterOf();
            const host = hostOf(cq);
            const gate = deferred();
            const entered = deferred();
            const original = host.subscribe;
            mock.method(
                host,
                'subscribe',
                async function (
                    this: any,
                    channel: string,
                    handler: typeof first,
                ) {
                    if (handler === first) {
                        entered.resolve();
                        await gate.promise;
                    }
                    await original.call(this, channel, handler);
                },
            );
            const old = cq.subscribe('Events', first);
            if (inFlight) {
                await entered.promise;
            }
            const clear = cq.unsubscribe();
            const replacement = cq.subscribe('Events', second);
            gate.resolve();
            await Promise.all([old, clear, replacement]);
            // A temporary installation ahead of teardown is harmless: progress is
            // reset by teardown, so the replacement is restored exactly once.
            assert.deepEqual(host.subscriptionHandlers, [second]);
            await cq.destroy();
        });
    }

    it('resets progress after a teardown that clears handlers then rejects', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        await cq.subscribe('Events', first);
        const unsub = mock.method(host, 'unsubscribe', async () => {
            host.subscriptionHandlers = [];
            throw new Error('teardown refused');
        });
        const clear = assert.rejects(cq.unsubscribe(), /teardown refused/);
        const replacement = cq.subscribe('Events', second);
        await Promise.all([clear, replacement]);
        assert.deepEqual(host.subscriptionHandlers, [second]);
        unsub.mock.restore();
        await cq.destroy();
    });

    it('leaves the host unsubscribed when teardown lands mid-install', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const gate = deferred();
        const entered = deferred();
        mock.method(
            host,
            'subscribe',
            async (_channel: string, handler: typeof first) => {
                entered.resolve();
                await gate.promise;
                host.subscriptionHandlers.push(handler);
            },
        );
        const install = cq.subscribe('Events', first);
        await entered.promise;
        let cleared = false;
        const clear = cq.unsubscribe().then(() => {
            cleared = true;
        });
        await settled();
        assert.equal(cleared, false, 'teardown waits for the host chain');
        gate.resolve();
        await Promise.all([install, clear]);
        assert.deepEqual(host.subscriptionHandlers, []);
        await cq.destroy();
    });

    it('does nothing when catch-up executes without a remembered channel', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const subscribe = mock.method(host, 'subscribe');
        // Exercise the empty-channel boundary independently of an empty list.
        cq.state.handlers = [first];
        await cq.syncHost(host);
        assert.equal(subscribe.mock.callCount(), 0);
        await cq.destroy();
    });

    it('keeps healthy hosts progressing while another subscription is stalled', async () => {
        const cq = clusterOf();
        const stalled = hostOf(cq);
        const healthy = hostOf(cq);
        const gate = deferred();
        mock.method(stalled, 'subscribe', () => gate.promise);
        const registration = cq.subscribe('Events', first);
        try {
            await settled();
            assert.deepEqual(healthy.subscriptionHandlers, [first]);
        } finally {
            gate.resolve();
            await registration;
            await cq.destroy();
        }
    });

    it('reports registration order and successful installs before a partial failure', async () => {
        const cq = clusterOf();
        const cap = capturing();
        cq.logger = cap.logger;
        await cq.subscribe('Events', first);
        await cq.subscribe('Events', second);
        const host = hostOf(cq);
        const original = host.subscribe;
        mock.method(
            host,
            'subscribe',
            async function (this: any, channel: string, handler: typeof first) {
                if (handler === second) throw new Error('refused');
                await original.call(this, channel, handler);
            },
        );
        await assert.rejects(cq.syncHost(host), /refused/);
        assert.equal(
            matching(cap.info, /registered handler #1 for channel Events/)
                .length,
            1,
        );
        assert.equal(
            matching(cap.info, /registered handler #2 for channel Events/)
                .length,
            1,
        );
        assert.equal(
            matching(cap.info, /installed 1 handler\(s\) for channel Events/)
                .length,
            1,
        );
        assert.equal(
            matching(cap.error, /some handlers remain uninstalled/).length,
            1,
        );
        await cq.destroy();
    });

    it('drops membership synchronously so queued work cannot reopen destroyed hosts', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const gate = deferred();
        const blocked = cq.enqueue(host, () => gate.promise);
        const queued = cq.subscribe('Events', first);
        await cq.destroy();

        // a destroyed cluster refuses new registrations rather than resolving
        // with nowhere to put them and repopulating the state destroy() cleared
        await assert.rejects(() => cq.subscribe('Events', second), TypeError);

        gate.resolve();
        await Promise.all([blocked, queued]);
        assert.deepEqual(host.subscriptionHandlers, []);
        assert.equal(cq.imqLength, 0);
        assert.equal(cq.state.channel, null);
        assert.deepEqual(cq.state.handlers, []);
    });

    it('closes discovery admission synchronously and keeps it closed after destroy', async () => {
        const cq = clusterOf();
        const address = { host: '127.0.0.1', port: 6612 };
        const host = cq.addServerWithQueueInitializing(address, false).imq;
        const gate = deferred();
        mock.method(host, 'destroy', () => gate.promise);
        const closing = cq.destroy();
        try {
            assert.equal(
                cq.addServer({ host: '127.0.0.1', port: 6613 }).imq,
                undefined,
            );
            assert.equal(cq.findServer(address), undefined);
            assert.equal(cq.imqLength, 0);
        } finally {
            gate.resolve();
            await closing;
        }
        assert.equal(cq.addServer(address).imq, undefined);
        assert.equal(cq.imqs.length, 0);
        await cq.destroy();
    });

    it('attempts every cleanup despite failures and retries only failed tasks', async () => {
        const cq = clusterOf();
        const healthy = hostOf(cq);
        const failed = hostOf(cq);
        const hostError = new Error('host refused');
        const managerError = new Error('manager refused');
        const healthyDestroy = mock.method(healthy, 'destroy');
        const failedDestroy = mock.method(failed, 'destroy', async () => {
            throw hostError;
        });
        const failedCluster = {};
        const healthyCluster = {};
        const remove = mock.fn((cluster: object) => {
            if (cluster === failedCluster) throw managerError;
            return Promise.resolve();
        });
        const otherRemove = mock.fn(async () => undefined);
        cq.options.clusterManagers = [{ remove }, { remove: otherRemove }];
        cq.initializedClusters = [failedCluster, healthyCluster];
        const one = cq.destroy();
        const two = cq.destroy();
        const results = await Promise.allSettled([one, two]);
        assert.ok(results[0].status === 'rejected');
        assert.ok(results[1].status === 'rejected');
        assert.equal(results[0].reason, results[1].reason);
        assert.deepEqual(results[0].reason.errors, [hostError, managerError]);
        assert.equal(healthyDestroy.mock.callCount(), 1);
        assert.equal(failedDestroy.mock.callCount(), 1);
        assert.equal(remove.mock.callCount(), 2);
        assert.equal(otherRemove.mock.callCount(), 2);
        assert.equal(
            cq.addServer({ host: '127.0.0.1', port: 6614 }).imq,
            undefined,
        );
        failedDestroy.mock.mockImplementation(async () => undefined);
        remove.mock.mockImplementation(async () => undefined);
        await cq.destroy();
        assert.equal(healthyDestroy.mock.callCount(), 1);
        assert.equal(failedDestroy.mock.callCount(), 2);
        assert.equal(remove.mock.callCount(), 3);
        assert.equal(remove.mock.calls[2].arguments[0], failedCluster);
        assert.equal(otherRemove.mock.callCount(), 2);
        await cq.destroy();
        assert.equal(failedDestroy.mock.callCount(), 2);
        assert.equal(remove.mock.callCount(), 3);
    });

    it('concurrent destroy callers await host teardown and manager removal', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const hostsDone = deferred();
        const managersDone = deferred();
        const enteredManager = deferred();
        const destroy = mock.method(host, 'destroy', () => hostsDone.promise);
        const remove = mock.fn(async () => {
            enteredManager.resolve();
            await managersDone.promise;
        });
        cq.options.clusterManagers = [{ remove }];
        cq.initializedClusters = [{}];
        const one = cq.destroy();
        let finished = false;
        const two = cq.destroy().then(() => {
            finished = true;
        });
        await settled();
        assert.equal(finished, false);
        await enteredManager.promise;
        hostsDone.resolve();
        await settled();
        assert.equal(finished, false);
        managersDone.resolve();
        await Promise.all([one, two]);
        assert.equal(destroy.mock.callCount(), 1);
        assert.equal(remove.mock.callCount(), 1);
    });

    it('concurrent destroy callers receive the teardown failure', async () => {
        const cq = clusterOf();
        const host = hostOf(cq);
        const gate = deferred();
        mock.method(host, 'destroy', () => gate.promise);
        const one = assert.rejects(cq.destroy(), AggregateError);
        const two = assert.rejects(cq.destroy(), AggregateError);
        gate.reject(new Error('teardown refused'));
        await Promise.all([one, two]);
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

/** Logger which keeps every line it was given, per level */
const capturing = (): any => {
    const join = (args: any[]): string =>
        args.map(arg => String(arg)).join(' ');
    const captured: any = { info: [], warn: [], error: [] };

    captured.logger = {
        log: () => undefined,
        info: (...args: any[]) => captured.info.push(join(args)),
        warn: (...args: any[]) => captured.warn.push(join(args)),
        error: (...args: any[]) => captured.error.push(join(args)),
    };

    return captured;
};

const matching = (lines: string[], rx: RegExp): string[] =>
    lines.filter(line => rx.test(line));

const unavailable = (imq: any, available: boolean): void => {
    Object.defineProperty(imq, 'available', {
        configurable: true,
        get: () => available,
    });
};

describe('ClusteredRedisQueue instance selection logging', () => {
    afterEach(() => mock.restoreAll());

    it('warns on entering the state where no instance is available', async () => {
        const cap = capturing();
        const cq: any = new ClusteredRedisQueue('SelectNone', {
            ...clusterConfig,
            logger: cap.logger,
        });

        cq.imqs.forEach((imq: any) => unavailable(imq, false));

        cq.selectQueue();
        cq.selectQueue();

        const lines = matching(cap.warn, /no available instance/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /out of 2/);

        unavailable(cq.imqs[0], true);
        cq.selectQueue();

        assert.equal(matching(cap.warn, /no available instance/).length, 1);

        unavailable(cq.imqs[0], false);
        cq.selectQueue();

        assert.equal(matching(cap.warn, /no available instance/).length, 2);

        await cq.destroy();
    });

    it('stays quiet while an instance is available', async () => {
        const cap = capturing();
        const cq: any = new ClusteredRedisQueue('SelectOk', {
            ...clusterConfig,
            logger: cap.logger,
        });

        cq.selectQueue();
        cq.selectQueue();

        assert.equal(matching(cap.warn, /no available instance/).length, 0);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue publish visibility', () => {
    afterEach(() => mock.restoreAll());

    it('reports an event published to an empty cluster once', async () => {
        const cap = capturing();
        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('PubEmpty', {
            clusterManagers: [clusterManager],
            logger: cap.logger,
        });

        await cq.publish({ ssn: '000-00-0000' }, 'FlowEvents');
        await cq.publish({ ssn: '000-00-0000' }, 'FlowEvents');

        const lines = matching(cap.error, /nothing published/);

        assert.equal(lines.length, 1);
        assert.match(lines[0], /FlowEvents/);
        assert.match(lines[0], /knownServers=0/);
        assert.equal(lines[0].includes('000-00-0000'), false);

        await cq.destroy();
    });

    it('stays quiet when the cluster has servers to publish to', async () => {
        const cap = capturing();
        const cq: any = new ClusteredRedisQueue('PubServers', {
            ...clusterConfig,
            logger: cap.logger,
        });

        mock.method(
            RedisQueue.prototype as any,
            'publish',
            async () => undefined,
        );

        await cq.publish({ a: 1 });

        assert.equal(matching(cap.error, /nothing published/).length, 0);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue joining-server failure logging', () => {
    afterEach(() => mock.restoreAll());

    it('names the host and the phase when a joining server cannot start', async () => {
        const cap = capturing();
        const cq: any = new ClusteredRedisQueue('JoinStartFail', {
            ...clusterConfig,
            logger: cap.logger,
        });
        const boom = Object.assign(new Error('host is down'), {
            code: 'ECONNREFUSED',
        });

        cq.state.started = true;

        const fake: any = {
            redisKey: '127.0.0.1:9999',
            start: () => Promise.reject(boom),
            destroy: () => Promise.resolve(),
        };

        cq.imqs.push(fake);

        let thrown: any;

        try {
            await cq.startHost(fake);
        } catch (err) {
            thrown = err;
        }

        const lines = matching(cap.error, /failed to start/);

        assert.equal(thrown, boom, 'the same value must be re-thrown');
        assert.equal(lines.length, 1);
        assert.match(lines[0], /127\.0\.0\.1:9999/);
        assert.match(lines[0], /ECONNREFUSED/);
        assert.equal(lines[0].includes('host is down'), false);

        await cq.destroy();
    });

    it('names the channel when a joining server cannot subscribe', async () => {
        const cap = capturing();
        const cq: any = new ClusteredRedisQueue('JoinSubFail', {
            ...clusterConfig,
            logger: cap.logger,
        });
        const boom = new Error('NOPERM no permissions');

        cq.state.started = false;
        cq.state.channel = 'FlowEvents';
        cq.state.handlers = [() => undefined];

        const fake: any = {
            redisKey: '127.0.0.1:9999',
            subscriptionHandlers: [],
            subscribe: () => Promise.reject(boom),
            destroy: () => Promise.resolve(),
        };

        cq.imqs.push(fake);

        let thrown: any;

        try {
            await cq.syncHost(fake);
        } catch (err) {
            thrown = err;
        }

        const lines = matching(cap.error, /failed to subscribe/);

        assert.equal(thrown, boom, 'the same value must be re-thrown');
        assert.equal(lines.length, 1);
        assert.match(lines[0], /FlowEvents/);
        assert.match(lines[0], /NOPERM/);

        await cq.destroy();
    });
});
