/*!
 * Additional RedisQueue tests: publish() branches
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue, IMQMode } from '../src';

function makeLogger() {
    return {
        log: (..._args: any[]) => undefined,
        info: (..._args: any[]) => undefined,
        warn: (..._args: any[]) => undefined,
        error: (..._args: any[]) => undefined,
    } as any;
}

describe('RedisQueue.publish()', function() {
    this.timeout(10000);

    it('should throw when writer is not connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('PubNoWriter', { logger }, IMQMode.PUBLISHER);

        let thrown: any;
        try {
            await rq.publish({ a: 1 });
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.be.instanceof(TypeError);
        expect(`${thrown}`).to.include('Writer is not connected');

        await rq.destroy().catch(() => undefined);
    });

    it('should publish to default channel when writer is connected', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('PubDefault', { logger }, IMQMode.PUBLISHER);
        await rq.start();

        const pubSpy = sinon.spy((rq as any).writer, 'publish');
        await rq.publish({ hello: 'world' });

        expect(pubSpy.called).to.equal(true);
        const [channel, msg] = pubSpy.getCall(0).args;
        expect(channel).to.equal('imq:PubDefault');
        expect(() => JSON.parse(msg)).not.to.throw();

        pubSpy.restore();
        await rq.destroy().catch(() => undefined);
    });

    it('should publish to provided toName channel when given', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('PubOther', { logger }, IMQMode.PUBLISHER);
        await rq.start();

        const pubSpy = sinon.spy((rq as any).writer, 'publish');
        await rq.publish({ t: true }, 'OtherChannel');

        expect(pubSpy.called).to.equal(true);
        const [channel] = pubSpy.getCall(0).args;
        expect(channel).to.equal('imq:OtherChannel');

        pubSpy.restore();
        await rq.destroy().catch(() => undefined);
    });
});
