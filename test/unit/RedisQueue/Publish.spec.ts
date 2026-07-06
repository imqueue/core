/*!
 * Additional RedisQueue tests: publish() branches
 */
import '../../mocks';
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue, IMQMode } from '../../../src';
import { makeLogger } from '../../helpers';

describe('RedisQueue.publish()', () => {
    it('should throw when writer is not connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubNoWriter',
            { logger },
            IMQMode.PUBLISHER,
        );

        let thrown: any;
        try {
            await rq.publish({ a: 1 });
        } catch (err) {
            thrown = err;
        }

        assert.ok(thrown instanceof TypeError);
        assert.ok(String(`${thrown}`).includes('Writer is not connected'));

        await rq.destroy().catch(() => undefined);
    });

    it('should publish to default channel when writer is connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubDefault',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();

        const pubSpy = mock.method((rq as any).writer, 'publish');
        await rq.publish({ hello: 'world' });

        assert.equal(pubSpy.mock.callCount() > 0, true);
        const [channel, msg] = pubSpy.mock.calls[0].arguments;
        assert.equal(channel, 'imq:PubDefault');
        assert.doesNotThrow(() => JSON.parse(msg));

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });

    it('should publish to provided toName channel when given', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue(
            'PubOther',
            { logger },
            IMQMode.PUBLISHER,
        );
        await rq.start();

        const pubSpy = mock.method((rq as any).writer, 'publish');
        await rq.publish({ t: true }, 'OtherChannel');

        assert.equal(pubSpy.mock.callCount() > 0, true);
        const [channel] = pubSpy.mock.calls[0].arguments;
        assert.equal(channel, 'imq:OtherChannel');

        mock.restoreAll();
        await rq.destroy().catch(() => undefined);
    });
});
