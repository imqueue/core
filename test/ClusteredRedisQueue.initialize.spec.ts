/*!
 * Additional tests for ClusteredRedisQueue.initializeQueue branches
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ClusteredRedisQueue, RedisQueue } from '../src';
import { ClusterManager } from '../src/ClusterManager';

describe('ClusteredRedisQueue.initializeQueue()', () => {
    it('should call imq.start when started and imq.subscribe when subscription is set', async () => {
        const startStub = sinon.stub(RedisQueue.prototype as any, 'start').resolves(undefined);
        const subscribeStub = sinon.stub(RedisQueue.prototype as any, 'subscribe').resolves();

        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('InitCover', { clusterManagers: [clusterManager] });

        // mark started and set subscription using public APIs
        await cq.start();
        const channel = 'X';
        const handler = () => undefined;
        await cq.subscribe(channel, handler);

        // adding a server triggers initializeQueue which should call start and subscribe
        cq.addServer({ host: '127.0.0.1', port: 6453 });

        // allow promises to resolve
        await new Promise(res => setTimeout(res, 0));

        expect(startStub.called).to.be.true;
        expect(subscribeStub.called).to.be.true;

        startStub.restore();
        subscribeStub.restore();
        await cq.destroy();
    });
});
