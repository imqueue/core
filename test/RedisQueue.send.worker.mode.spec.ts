/*!
 * Additional RedisQueue tests: send() worker-only mode error
 */
import './mocks';
import { expect } from 'chai';
import { RedisQueue, IMQMode } from '../src';

function makeLogger() {
    return {
        log: (..._args: any[]) => undefined,
        info: (..._args: any[]) => undefined,
        warn: (..._args: any[]) => undefined,
        error: (..._args: any[]) => undefined,
    } as any;
}

describe('RedisQueue.send() worker-only mode', function() {
    this.timeout(10000);

    it('should throw when called in WORKER only mode', async () => {
        const logger = makeLogger();
        const rq: any = new RedisQueue('WorkerOnly', { logger }, IMQMode.WORKER);

        let thrown: any;
        try {
            await rq.send('AnyQueue', { test: true });
        } catch (err) {
            thrown = err;
        }

        expect(thrown).to.be.instanceof(TypeError);
        expect(`${thrown}`).to.include('WORKER only mode');

        await rq.destroy().catch(() => undefined);
    });
});
