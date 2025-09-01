/*!
 * Additional branch coverage for UDPClusterManager
 */
import './mocks';
import { expect } from 'chai';
import { UDPClusterManager } from '../src';

describe('UDPClusterManager additional branches', () => {
    describe('processMessageOnCluster added-path', () => {
        const processMessageOnCluster = (UDPClusterManager as any).processMessageOnCluster as any;

        it('should call serverAliveWait when server is added and found (added truthy)', async () => {
            const calls: any[] = [];
            const addedServer: any = { id: 'id', host: '127.0.0.1', port: 6379 };
            const cluster: any = {
                add: (message: any) => { calls.push(['add', message]); },
                find: (message: any, strict?: boolean) => strict ? addedServer : undefined,
            };
            const original = (UDPClusterManager as any).serverAliveWait;
            let waited = false;
            (UDPClusterManager as any).serverAliveWait = (...args: any[]) => {
                waited = true;
            };

            processMessageOnCluster(cluster, { id: 'id', name: 'n', type: 'up', host: 'h', port: 1, timeout: 0 }, 5);

            // allow microtask queue
            await new Promise(res => setTimeout(res, 0));

            expect(waited).to.equal(true);
            // restore
            (UDPClusterManager as any).serverAliveWait = original;
        });
    });

    describe('serverAliveWait branches', () => {
        const serverAliveWait = (UDPClusterManager as any).serverAliveWait as any;

        it('should return early when computed timeout is <= 0', () => {
            const cluster: any = { find: () => ({}) };
            const server: any = {};

            serverAliveWait(cluster, server, 0); // no message and correction 0 => timeout 0

            expect(server.timer).to.equal(undefined);
        });
    });
});
