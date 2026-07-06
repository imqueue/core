/*!
 * Additional RedisQueue tests: processDelayed() catch branch
 */
import '../../mocks';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.processDelayed extra branches', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should emit error when evalsha throws', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('ProcessDelayedCatch', { logger });
        await rq.start();

        // Force checksum to exist to enter evalsha path
        rq.scripts.moveDelayed.checksum = 'deadbeef';

        const err = new Error('evalsha failed');
        const emitErrorStub: Mock<any> = mock.method(
            (RedisQueue as any).prototype,
            'emitError',
            () => undefined,
        );

        // Temporarily drop writer to force a synchronous error in processDelayed
        const originalWriter = rq.writer;
        rq['writer'] = undefined;

        await rq['processDelayed'](rq.key);

        assert.ok(emitErrorStub.mock.callCount() > 0);
        assert.equal(
            emitErrorStub.mock.calls[0].arguments[0],
            'OnProcessDelayed',
        );

        // Restore writer and cleanup
        rq['writer'] = originalWriter;
        await rq.destroy();
    });
});
