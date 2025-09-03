/*!
 * UDPClusterManager.selectNetworkInterface() branch coverage tests
 */
import './mocks';
import { expect } from 'chai';
import * as mock from 'mock-require';

describe('UDPClusterManager.selectNetworkInterface()', () => {
    it('should return default when broadcastAddress is undefined', async () => {
        const { UDPClusterManager } = await import('../src');
        const select = (UDPClusterManager as any).selectNetworkInterface as Function;
        const res = select({});
        expect(res).to.equal('0.0.0.0');
    });

    it('should return default when broadcastAddress equals limitedBroadcastAddress', async () => {
        const { UDPClusterManager } = await import('../src');
        const select = (UDPClusterManager as any).selectNetworkInterface as Function;
        const res = select({ broadcastAddress: '127.0.0.255', limitedBroadcastAddress: '127.0.0.255' });
        expect(res).to.equal('0.0.0.0');
    });

    it('should continue on undefined interface entry and still select matching address', () => {
        // Re-mock os.networkInterfaces to include an undefined entry
        const os = require('node:os');
        const networkInterfaces = () => ({ bad: undefined, lo: [{ address: '127.0.0.1', family: 'IPv4' }] });
        mock.stop('os');
        mock('os', Object.assign({}, os, { networkInterfaces }));
        // Re-require the module to capture new binding
        const { UDPClusterManager } = mock.reRequire('../src/UDPClusterManager');
        const res = (UDPClusterManager as any).selectNetworkInterface({ address: '127.0.0.255', limitedAddress: '255.255.255.255' });
        expect(res).to.equal('127.0.0.1');

        // restore to base mocks for other tests
        mock.stop('os');
        mock.reRequire('./mocks/os');
        mock.reRequire('../src/UDPClusterManager');
    });

    it('should select matching interface address when not equal to limited broadcast', async () => {
        const { UDPClusterManager } = await import('../src');
        const select = (UDPClusterManager as any).selectNetworkInterface as Function;
        const res = select({ broadcastAddress: '127.0.0.255', limitedBroadcastAddress: '255.255.255.255' });
        expect(res).to.equal('127.0.0.1');
    });
});
