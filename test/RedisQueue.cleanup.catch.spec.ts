/*!
 * Additional RedisQueue tests: processCleanup catch branch
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue } from '../src';
import { logger as testLogger } from './mocks';

function makeLogger() {
    return {
        log: (..._args: any[]) => undefined,
        info: (..._args: any[]) => undefined,
        warn: (..._args: any[]) => undefined,
        error: (..._args: any[]) => undefined,
    } as any;
}

describe('RedisQueue.processCleanup catch path', function() {
    this.timeout(10000);

    it('should log a warning when processCleanup throws', async () => {
        const logger = makeLogger();
        const warnSpy = sinon.spy(logger, 'warn');
        const rq: any = new RedisQueue('CleanupCatch', {
            logger,
            cleanup: true,
        });

        await rq.start();
        // Stub writer.client to throw to hit the catch branch
        const stub = sinon.stub(rq.writer, 'client').throws(new Error('LIST failed'));

        await rq.processCleanup();

        expect(warnSpy.called).to.be.true;

        stub.restore();
        await rq.destroy();
    });
});
