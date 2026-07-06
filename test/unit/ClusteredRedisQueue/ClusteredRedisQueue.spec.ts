/*!
 * ClusteredRedisQueue Unit Tests (core behavior + EventEmitter proxy methods)
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
import { logger } from '../../mocks';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusteredRedisQueue } from '../../../src';
import { ClusterManager } from '../../../src/ClusterManager';

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
});
