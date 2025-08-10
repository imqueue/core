/*!
 * UDPClusterManager serverAliveWait: cover currentTimeout left side (existing.timeout truthy)
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { UDPClusterManager } from '../src';

describe('UDPClusterManager.serverAliveWait truthy timeout', () => {
    it('should use existing.timeout (truthy) in currentTimeout and remove on expiry', async () => {
        const server: any = { host: 'h', port: 1, timer: undefined, timeout: 2, timestamp: undefined };
        const cluster: any = {
            find: sinon.stub().callsFake((_s: any, _strict?: boolean) => server),
            remove: sinon.stub(),
        };
        const clock = sinon.useFakeTimers();
        try {
            (UDPClusterManager as any).serverAliveWait(cluster, server, 0);
            clock.tick(3);
            expect(cluster.remove.called).to.equal(true);
        } finally {
            clock.restore();
        }
    });
});
