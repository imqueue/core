/*!
 * Additional RedisQueue tests: send() extra branches
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue, IMQMode } from '../src';
import { logger as testLogger } from './mocks';

function makeLogger() {
    return {
        log: (..._args: any[]) => undefined,
        info: (..._args: any[]) => undefined,
        warn: (..._args: any[]) => undefined,
        error: (..._args: any[]) => undefined,
    } as any;
}

describe('RedisQueue.send() extra branches', function() {
    this.timeout(10000);

    it('should throw when writer is still uninitialized after start()', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('SendNoWriter', { logger }, IMQMode.PUBLISHER);
        // Force start to be a no-op so writer remains undefined
        const startStub = sinon.stub(rq, 'start').resolves(rq);

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.be.instanceof(TypeError);
        expect(`${thrown}`).to.include('unable to initialize queue');

        startStub.restore();
        await rq.destroy().catch(() => undefined);
    });
});
