/*!
 * UDPClusterManager.free() coverage test
 */
import './mocks';
import { expect } from 'chai';

describe('UDPClusterManager.free()', () => {
    it('should destroy all sockets via destroySocket and clear sockets map', async () => {
        const { UDPClusterManager } = await import('../src');
        const sockets = (UDPClusterManager as any).sockets as Record<string, any>;
        // prepare two mock sockets
        sockets['0.0.0.0:5555'] = {
            removeAllListeners: () => {},
            close: (cb: Function) => cb(),
            unref: () => {},
        };
        sockets['0.0.0.0:6666'] = {
            removeAllListeners: () => {},
            close: (cb: Function) => cb(),
            unref: () => {},
        };

        await (UDPClusterManager as any).free();

        expect(Object.keys((UDPClusterManager as any).sockets)).to.have.length(0);
    });
});
