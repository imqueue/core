/*!
 * Additional tests for ClusteredRedisQueue.initializeQueue branches
 */
import '../../mocks';
import { describe, it, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusteredRedisQueue, RedisQueue } from '../../../src';
import { ClusterManager } from '../../../src/ClusterManager';

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
