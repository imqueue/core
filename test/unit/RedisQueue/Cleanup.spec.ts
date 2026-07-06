/*!
 * Additional RedisQueue tests: processCleanup catch branch
 */
import '../../mocks';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.processCleanup catch path', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should log a warning when processCleanup throws', async () => {
        const logger = makeLogger();
        const warnSpy: Mock<any> = mock.method(logger, 'warn');
        const rq: any = new RedisQueue('CleanupCatch', {
            logger,
            cleanup: true,
        });

        await rq.start();
        // Stub writer.client to throw to hit the catch branch
        mock.method(rq.writer, 'client', () => {
            throw new Error('LIST failed');
        });

        await rq.processCleanup();

        assert.ok(warnSpy.mock.callCount() > 0);

        await rq.destroy();
    });
});
