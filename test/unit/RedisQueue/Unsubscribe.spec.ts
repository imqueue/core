/*!
 * Additional RedisQueue tests: unsubscribe() cleanup path
 */
import '../../mocks';
import { describe, it, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.unsubscribe()', () => {
    it('should cleanup subscription channel when present', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('SubUnsub', { logger });
        await rq.start();

        const handler = mock.fn();
        await rq.subscribe('SubUnsub', handler);

        assert.ok(rq.subscription);
        assert.equal(rq.subscriptionName, 'SubUnsub');

        const unsubSpy = mock.method(rq.subscription, 'unsubscribe');
        const ralSpy = mock.method(rq.subscription, 'removeAllListeners');
        const disconnectSpy = mock.method(rq.subscription, 'disconnect');
        const quitSpy = mock.method(rq.subscription, 'quit');

        await rq.unsubscribe();

        assert.equal(unsubSpy.mock.callCount(), 1);
        assert.equal(ralSpy.mock.callCount(), 1);
        assert.equal(disconnectSpy.mock.callCount(), 1);
        assert.equal(quitSpy.mock.callCount(), 1);
        assert.equal(rq.subscription, undefined);
        assert.equal(rq.subscriptionName, undefined);

        mock.restoreAll();

        await rq.destroy().catch(() => undefined);
    });
});
