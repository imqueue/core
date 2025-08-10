/*!
 * ClusteredRedisQueue.addServerWithQueueInitializing default param branch
 */
import './mocks';
import { expect } from 'chai';
import { ClusteredRedisQueue } from '../src';

describe('ClusteredRedisQueue.addServerWithQueueInitializing() default param', () => {
    it('should use default initializeQueue=true when second param omitted', async () => {
        const cq: any = new ClusteredRedisQueue('CQ-Default', {
            logger: console,
            cluster: [{ host: '127.0.0.1', port: 6379 }],
        });
        // prevent any actual start/subscription side-effects
        (cq as any).state.started = false;
        (cq as any).state.subscription = null;

        const server = { host: '192.168.0.1', port: 6380 };
        const initializedSpy = new Promise<void>((resolve) => {
            cq['clusterEmitter'].once('initialized', () => resolve());
        });

        // Call without the second argument to hit default "true" branch
        (cq as any).addServerWithQueueInitializing(server);

        await initializedSpy; // should emit initialized when default is true

        // Ensure the server added and queue length updated
        expect((cq as any).servers.some((s: any) => s.host === server.host && s.port === server.port)).to.equal(true);
        expect((cq as any).queueLength).to.equal((cq as any).imqs.length);

        await cq.destroy();
    });
});
