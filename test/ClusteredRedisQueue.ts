/*!
 * RedisQueue Unit Tests
 *
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
 */
import * as mocks from './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ClusteredRedisQueue } from '../src';
import { ClusterManager } from '../src/ClusterManager';

process.setMaxListeners(100);

const clusterConfig = {
    logger: mocks.logger,
    cluster: [{
        host: '127.0.0.1',
        port: 7777
    }, {
        host: '127.0.0.1',
        port: 8888
    }]
};

describe('ClusteredRedisQueue', function() {
    this.timeout(30000);

    it('should be a class', () => {
        expect(typeof ClusteredRedisQueue).to.equal('function');
    });

    it('should implement IMessageQueue interface', () => {
        expect(typeof ClusteredRedisQueue.prototype.start)
            .to.equal('function');
        expect(typeof ClusteredRedisQueue.prototype.stop)
            .to.equal('function');
        expect(typeof ClusteredRedisQueue.prototype.send)
            .to.equal('function');
        expect(typeof ClusteredRedisQueue.prototype.destroy)
            .to.equal('function');
    });

    describe('constructor()', () => {
        it('should throw with improper options passed', () => {
            expect(() => new ClusteredRedisQueue('TestClusteredQueue'))
                .to.throw(TypeError);
        });

        it('should not throw if proper options passed', () => {
            expect(() => new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            )).not.to.throw(TypeError);
        });

        it('should initialize cluster manager', () => {
            const clusterManager = new (ClusterManager as any)();

            sinon.spy(clusterManager, 'init');

            new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            expect(clusterManager.init.called).to.be.true;
        });
    });

    describe('start()', () => {
        it('should start each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            );

            cq.imqs.forEach((imq: any) => {
                sinon.spy(imq, 'start');
            });

            await cq.start();

            cq.imqs.forEach((imq: any) => {
                expect(imq.start.called).to.be.true;
            });

            await cq.destroy();
        });
    });

    describe('stop()', () => {
        it('should stop each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            );

            cq.imqs.forEach((imq: any) => {
                sinon.spy(imq, 'stop');
            });

            await cq.stop();

            cq.imqs.forEach((imq: any) => {
                expect(imq.stop.called).to.be.true;
            });

            await cq.destroy();
        });
    });

    describe('send()', () => {
        it('should balance send requests round-robin manner across nested ' +
            'queues', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            );

            cq.imqs.forEach((imq: any) => {
                sinon.spy(imq, 'send');
            });

            await cq.send('TestClusteredQueue', { 'hello': 'world' });

            expect(cq.imqs[0].send.calledOnce).to.be.true;
            expect(cq.imqs[1].send.called).to.be.false;

            await cq.send('TestClusteredQueue', { 'hello': 'world' });

            expect(cq.imqs[0].send.calledOnce).to.be.true;
            expect(cq.imqs[1].send.calledOnce).to.be.true;

            await cq.send('TestClusteredQueue', { 'hello': 'world' });

            expect(cq.imqs[0].send.calledTwice).to.be.true;
            expect(cq.imqs[1].send.calledOnce).to.be.true;

            await cq.destroy();
        });

        it('should send message after queue was initialized', done => {
            const clusterManager = new (ClusterManager as any)();
            const cqOne: any = new ClusteredRedisQueue(
                'TestClusteredQueueOne',
                {
                    clusterManagers: [clusterManager],
                    logger: mocks.logger,
                },
            );
            const cqTwo: any = new ClusteredRedisQueue(
                'TestClusteredQueueTwo',
                {
                    clusterManagers: [clusterManager],
                    logger: mocks.logger,
                },
            );
            const message = { 'hello': 'world' };

            cqOne.start();
            cqTwo.start();

            cqTwo.on('message', () => {
                done();
            });

            cqOne.send('TestClusteredQueueTwo', message);
            cqTwo.addServer(clusterConfig.cluster[0]);
            cqOne.addServer(clusterConfig.cluster[0]);
        });
    });

    describe('destroy()', () => {
        it('should destroy each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            );

            cq.imqs.forEach((imq: any) => {
                sinon.spy(imq, 'destroy');
            });

            await cq.destroy();

            cq.imqs.forEach((imq: any) => {
                expect(imq.destroy.called).to.be.true;
            });
        });
    });

    describe('clear()', () => {
        it('should clear each nested imq', async () => {
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                clusterConfig
            );

            cq.imqs.forEach((imq: any) => {
                sinon.spy(imq, 'clear');
            });

            await cq.clear();

            cq.imqs.forEach((imq: any) => {
                expect(imq.clear.called).to.be.true;
            });

            await cq.destroy();
        });
    });

    describe('subscribe()', () => {
        it('should subscribe after queue initialization', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                {
                    clusterManagers: [clusterManager],
                    logger: mocks.logger,
                },
            );
            const channel = 'TestChannel';

            cq.subscribe(channel, () => {});
            cq.addServer(clusterConfig.cluster[0]);

            expect(cq.imqs[0].subscriptionName).to.be.equal(channel);
        });
    });

    describe('addServer()', () => {
        it('should add cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            cq.addServer(clusterConfig.cluster[0]);

            expect(cq.servers.length).to.be.equal(1);
        });

        it('should call adding cluster server method through the'
            + ' Cluster Manager', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            for (const server of clusterManager.clusters) {
                 server.add(clusterConfig.cluster[0]);
            }

            expect(cq.servers.length).to.be.equal(1);
        });
    });

    describe('removeServer()', () => {
        it('should remove cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            cq.addServer(clusterConfig.cluster[0]);
            cq.removeServer(clusterConfig.cluster[0]);

            expect(cq.servers.length).to.be.equal(0);
        });

        it('should call removing cluster server method through the'
            + ' Cluster Manager', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            for (const server of clusterManager.clusters) {
                 server.remove(clusterConfig.cluster[0]);
            }

            expect(cq.servers.length).to.be.equal(0);
        });
    });

    describe('findServer()', () => {
        it('should find cluster server', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            cq.addServer(clusterConfig.cluster[0]);

            const server = cq.findServer(clusterConfig.cluster[0]);

            expect(server).to.deep.include(clusterConfig.cluster[0]);
        });

        it('should call find cluster server method through the'
            + ' Cluster Manager', () => {
            const clusterManager = new (ClusterManager as any)();
            const cq: any = new ClusteredRedisQueue(
                'TestClusteredQueue',
                { clusterManagers: [clusterManager] },
            );

            cq.addServer(clusterConfig.cluster[0]);

            for (const cluster of clusterManager.clusters) {
                const server = cluster.find(clusterConfig.cluster[0]);

                expect(server).to.deep.include(clusterConfig.cluster[0]);
            }
        });
    });
});
