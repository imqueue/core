/*!
 * Additional RedisQueue tests: send() extra branches and worker-only mode
 */
import '../../mocks';
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue, IMQMode } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.send() extra branches', () => {
    it('should throw when writer is still uninitialized after start()', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'SendNoWriter',
            { logger },
            IMQMode.PUBLISHER,
        );
        // Force start to be a no-op so writer remains undefined
        const startStub = mock.method(rq, 'start', async () => rq);

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('unable to initialize queue'));

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});

describe('RedisQueue.send() worker-only mode', () => {
    it('should throw when called in WORKER only mode', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'WorkerOnly',
            { logger },
            IMQMode.WORKER,
        );

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('WORKER only mode'));

        await rq.destroy().catch(() => undefined);
    });
});
