/*!
 * Additional tests for ClusteredRedisQueue event emitter proxy methods
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ClusteredRedisQueue } from '../src';
import { ClusterManager } from '../src/ClusterManager';

const clusterConfig = {
    cluster: [
        { host: '127.0.0.1', port: 6379 },
    ],
};

describe('ClusteredRedisQueue - EventEmitter proxy methods', () => {
    it('should cover rawListeners/getMaxListeners/eventNames/listenerCount/emit', async () => {
        const clusterManager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('ProxyQueue', {
            clusterManagers: [clusterManager],
        });

        // add underlying server and listener
        cq.addServer(clusterConfig.cluster[0]);
        const handler = sinon.spy();
        cq.imqs[0].on('test', handler);

        // set max listeners across emitters and verify getMaxListeners uses templateEmitter
        cq.setMaxListeners(20);
        expect(cq.getMaxListeners()).to.equal(20);

        // collect raw listeners
        const raw = cq.rawListeners('test');
        expect(raw.length).to.be.greaterThan(0);

        // event names come from underlying imq
        const names = cq.eventNames();
        expect(names).to.be.an('array');
        expect(names.map(String)).to.include('test');

        // listener count is aggregated via templateEmitter method applied on imq[0]
        expect(cq.listenerCount('test')).to.equal(1);

        // emit should return true
        expect(cq.emit('test', 1, 2, 3)).to.equal(true);
        expect(handler.calledOnce).to.be.true;
    });
});
