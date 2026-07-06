/*!
 * ClusteredRedisQueue.addServerWithQueueInitializing tests
 * (default initializeQueue param branch + initializeQueue=false branch)
 */
import '../../mocks';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusteredRedisQueue } from '../../../src';
import { ClusterManager } from '../../../src/ClusterManager';

const server = { host: '127.0.0.1', port: 6380 };

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
        const initializedSpy = new Promise<void>(resolve => {
            cq['clusterEmitter'].once('initialized', () => resolve());
        });

        // Call without the second argument to hit default "true" branch
        (cq as any).addServerWithQueueInitializing(server);

        await initializedSpy; // should emit initialized when default is true

        // Ensure the server added and queue length updated
        assert.equal(
            (cq as any).servers.some(
                (s: any) => s.host === server.host && s.port === server.port,
            ),
            true,
        );
        assert.equal((cq as any).imqLength, (cq as any).imqs.length);

        await cq.destroy();
    });
});

describe('ClusteredRedisQueue.addServerWithQueueInitializing(false)', () => {
    it('should add server without initializing queue and not emit initialized', async () => {
        const manager = new (ClusterManager as any)();
        const cq: any = new ClusteredRedisQueue('NoInit', {
            clusterManagers: [manager],
        });

        let initializedCalled = false;
        (cq as any).clusterEmitter.on('initialized', () => {
            initializedCalled = true;
        });

        // call private method via any to cover branch
        (cq as any).addServerWithQueueInitializing(server, false);

        // should have server and imq added
        assert.ok(cq.servers.length > 0);
        assert.ok(cq.imqs.length > 0);
        // queueLength updated
        assert.equal(cq.imqLength, cq.imqs.length);
        // initialized not emitted
        assert.equal(initializedCalled, false);

        await cq.destroy();
    });
});
