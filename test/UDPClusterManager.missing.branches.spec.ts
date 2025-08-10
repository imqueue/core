/*!
 * UDPClusterManager missing branches coverage
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { UDPClusterManager } from '../src';

describe('UDPClusterManager - cover remaining branches', () => {
    it('serverAliveWait should handle existing.timeout falsy (|| 0) path and remove on timeout', async () => {
        // Arrange cluster stub
        const server: any = { host: 'h', port: 1, timer: undefined, timeout: undefined, timestamp: undefined };
        const cluster: any = {
            find: sinon.stub().callsFake((_s: any, _strict?: boolean) => server),
            remove: sinon.stub(),
        };

        // Use fake timers to control setTimeout and Date
        const clock = sinon.useFakeTimers();
        try {
            // make timestamp truthy
            clock.tick(1);
            // Alive correction > 0 ensures timer is scheduled even if timeout is falsy
            (UDPClusterManager as any).serverAliveWait(cluster, server, 1);
            // Advance time to trigger setTimeout callback and make delta >= currentTimeout (1ms)
            clock.tick(2);

            expect(cluster.remove.called).to.equal(true);
        } finally {
            clock.restore();
        }
    });

    it('destroySocket should call socket.unref() when socket is present', async () => {
        // Prepare fake socket with unref
        const unref = sinon.spy();
        const removeAll = sinon.spy();
        const sock: any = {
            removeAllListeners: removeAll,
            close: (cb: (err?: any) => void) => cb(),
            unref,
        };
        const key = 'test-key';
        (UDPClusterManager as any).sockets[key] = sock;
        await (UDPClusterManager as any).destroySocket(key, sock);
        expect(unref.called).to.equal(true);
        expect((UDPClusterManager as any).sockets[key]).to.equal(undefined);
    });

    it('destroySocket should work when socket.unref() is absent (optional chaining negative branch)', async () => {
        const removeAll = sinon.spy();
        const sock: any = {
            removeAllListeners: removeAll,
            close: (cb: (err?: any) => void) => cb(),
            // no unref method
        };
        const key = 'test-key-2';
        (UDPClusterManager as any).sockets[key] = sock;
        await (UDPClusterManager as any).destroySocket(key, sock);
        // should not throw, sockets map cleaned
        expect((UDPClusterManager as any).sockets[key]).to.equal(undefined);
    });
});
