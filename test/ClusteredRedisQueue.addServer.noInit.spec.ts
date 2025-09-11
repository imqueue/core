/*!
 * Cover ClusteredRedisQueue.addServerWithQueueInitializing with initializeQueue=false
 */
import './mocks';
import { expect } from 'chai';
import { ClusteredRedisQueue } from '../src';
import { ClusterManager } from '../src/ClusterManager';

const server = { host: '127.0.0.1', port: 6380 };

describe('ClusteredRedisQueue.addServerWithQueueInitializing(false)', () => {
    it('should add server without initializing queue and not emit initialized', async () => {
        const manager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('NoInit', { clusterManagers: [manager] });

        let initializedCalled = false;
        (cq as any).clusterEmitter.on('initialized', () => { initializedCalled = true; });

        // call private method via any to cover branch
        (cq as any).addServerWithQueueInitializing(server, false);

        // should have server and imq added
        expect(cq.servers.length).to.be.greaterThan(0);
        expect(cq.imqs.length).to.be.greaterThan(0);
        // queueLength updated
        expect(cq.imqLength).to.equal(cq.imqs.length);
        // initialized not emitted
        expect(initializedCalled).to.equal(false);

        await cq.destroy();
    });
});
