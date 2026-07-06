/*!
 * UDPClusterManager.destroyWorker() behavior tests aligned with implementation
 */
import '../../mocks';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { UDPClusterManager } from '../../../src';

describe('UDPClusterManager.destroyWorker()', () => {
    it('should resolve when worker is undefined (no-op)', async () => {
        const destroy = (UDPClusterManager as any).destroyWorker as Function;
        await destroy('0.0.0.0:63000', undefined);
    });

    it('should terminate worker and remove it from the workers map', async () => {
        const destroy = (UDPClusterManager as any).destroyWorker as Function;
        const workers = (UDPClusterManager as any).workers as Record<
            string,
            any
        >;
        const key = '1.2.3.4:65000';

        let terminated = false;
        const fakeWorker: any = {
            postMessage: () => {},
            once: (event: string, cb: Function) => {
                if (event === 'message') {
                    setImmediate(() => cb({ type: 'stopped' }));
                }
            },
            terminate: () => {
                terminated = true;
            },
        };

        workers[key] = fakeWorker;
        await destroy(key, fakeWorker);

        assert.equal(terminated, true);
        assert.equal(workers[key], undefined);
    });
});
