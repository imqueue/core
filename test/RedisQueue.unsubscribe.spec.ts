/*!
 * Additional RedisQueue tests: unsubscribe() cleanup path
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue } from '../src';

function makeLogger() {
    return {
        log: (..._args: any[]) => undefined,
        info: (..._args: any[]) => undefined,
        warn: (..._args: any[]) => undefined,
        error: (..._args: any[]) => undefined,
    } as any;
}

describe('RedisQueue.unsubscribe()', function() {
    this.timeout(10000);

    it('should cleanup subscription channel when present', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('SubUnsub', { logger });
        await rq.start();

        const handler = sinon.spy();
        await rq.subscribe('SubUnsub', handler);

        expect(rq.subscription).to.be.ok;
        expect(rq.subscriptionName).to.equal('SubUnsub');

        const unsubSpy = sinon.spy(rq.subscription, 'unsubscribe');
        const ralSpy = sinon.spy(rq.subscription, 'removeAllListeners');
        const disconnectSpy = sinon.spy(rq.subscription, 'disconnect');
        const quitSpy = sinon.spy(rq.subscription, 'quit');

        await rq.unsubscribe();

        expect(unsubSpy.calledOnce).to.equal(true);
        expect(ralSpy.calledOnce).to.equal(true);
        expect(disconnectSpy.calledOnce).to.equal(true);
        expect(quitSpy.calledOnce).to.equal(true);
        expect(rq.subscription).to.equal(undefined);
        expect(rq.subscriptionName).to.equal(undefined);

        unsubSpy.restore();
        ralSpy.restore();
        disconnectSpy.restore();
        quitSpy.restore();

        await rq.destroy().catch(() => undefined);
    });
});
