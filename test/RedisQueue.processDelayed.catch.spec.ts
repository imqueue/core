/*!
 * Additional RedisQueue tests: processDelayed() catch branch
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

describe('RedisQueue.processDelayed extra branches', function() {
    this.timeout(10000);

    it('should emit error when evalsha throws', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('ProcessDelayedCatch', { logger });
        await rq.start();

        // Force checksum to exist to enter evalsha path
        rq.scripts.moveDelayed.checksum = 'deadbeef';

        const err = new Error('evalsha failed');
        const emitErrorStub = sinon.stub((RedisQueue as any).prototype, 'emitError');

        // Temporarily drop writer to force a synchronous error in processDelayed
        const originalWriter = rq.writer;
        rq['writer'] = undefined;

        await rq['processDelayed'](rq.key);

        expect(emitErrorStub.called).to.be.true;
        expect(emitErrorStub.firstCall.args[0]).to.equal('OnProcessDelayed');

        // Restore writer and cleanup
        rq['writer'] = originalWriter;
        emitErrorStub.restore();
        await rq.destroy();
    });
});
