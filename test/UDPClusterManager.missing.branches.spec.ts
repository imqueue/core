/*!
 * UDPClusterManager missing branches coverage
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { UDPClusterManager } from '../src';

describe('UDPClusterManager - cover remaining branches', () => {
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
