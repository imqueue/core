/*!
 * Additional RedisQueue tests for processCleanup branches
 */
import './mocks';
import { expect } from 'chai';
import { RedisQueue, uuid } from '../src';
import { RedisClientMock } from './mocks';

describe('RedisQueue.processCleanup extra branches', function() {
    this.timeout(5000);

    it('should remove scanned keys that do not match any connectedKey (different prefix)', async () => {
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imqX',
            cleanupFilter: '*',
        });

        // start to create reader/writer/watcher with connection names
        await rq.start();

        // Create an orphan worker key with a different prefix so it won't include any connectedKey
        const orphanKey = 'imqY:orphan:worker:someuuid:123456';
        (RedisClientMock as any).__queues__[orphanKey] = ['payload'];

        // Sanity: ensure the key is present before cleanup
        expect((RedisClientMock as any).__queues__[orphanKey]).to.be.ok;

        await rq.processCleanup();

        // The orphan key should be deleted by cleanup (true branch of keysToRemove filter)
        expect((RedisClientMock as any).__queues__[orphanKey]).to.be.undefined;

        await rq.destroy();
    });
});
