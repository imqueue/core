/*!
 * Additional RedisQueue tests: connect() option fallbacks branches
 */
import '../../mocks';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue, IMQMode } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.connect() option fallbacks', () => {
    it('should use fallback values when falsy options are provided', async () => {
        const logger = makeLogger();
        // Intentionally provide falsy values to trigger `||` fallbacks in connect()
        const rq: any = new RedisQueue(
            'ConnFallbacks',
            {
                logger,
                port: 0 as unknown as number, // falsy to trigger 6379 fallback
                host: '' as unknown as string, // falsy to trigger 'localhost' fallback
                prefix: '' as unknown as string, // falsy to trigger '' fallback in connectionName
                cleanup: false,
            },
            IMQMode.BOTH,
        );

        await rq.start();

        // Basic sanity: writer/reader/watcher are created
        assert.equal(Boolean(rq.writer), true);
        assert.equal(Boolean(rq.reader), true);
        assert.equal(Boolean(rq.watcher), true);

        await rq.destroy();
    });
});
