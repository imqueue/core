/*!
 * UDPClusterManager.destroySocket() branch coverage tests
 */
import './mocks';
import { expect } from 'chai';
import { UDPClusterManager } from '../src';

describe('UDPClusterManager.destroySocket()', () => {
    it('should resolve when socket has no close() function', async () => {
        const destroy = (UDPClusterManager as any).destroySocket as Function;
        const fakeSocket: any = { /* no close, no removeAllListeners */ };

        await destroy('0.0.0.0:63000', fakeSocket);
    });

    it('should reject when removeAllListeners throws inside try-block', async () => {
        const destroy = (UDPClusterManager as any).destroySocket as Function;
        const fakeSocket: any = {
            removeAllListeners: () => { throw new Error('boom'); },
            close: (cb: Function) => cb && cb(),
        };

        let thrown = null as any;
        try {
            await destroy('1.1.1.1:63000', fakeSocket);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.equal('boom');
    });

    it('should remove socket entry and unref after successful close()', async () => {
        const destroy = (UDPClusterManager as any).destroySocket as Function;
        const sockets = (UDPClusterManager as any).sockets as Record<string, any>;
        const key = '9.9.9.9:65000';

        let unrefCalled = false;
        const fakeSocket: any = {
            removeAllListeners: () => {},
            close: (cb: Function) => cb && cb(),
            unref: () => { unrefCalled = true; },
        };

        sockets[key] = fakeSocket;
        await destroy(key, fakeSocket);

        expect(unrefCalled).to.equal(true);
        expect(sockets[key]).to.be.undefined;
    });
});
