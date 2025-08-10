/*!
 * Additional RedisQueue tests: connect() option fallbacks branches
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

describe('RedisQueue.connect() option fallbacks', function() {
    this.timeout(10000);

    it('should use fallback values when falsy options are provided', async () => {
        const logger = makeLogger();
        // Intentionally provide falsy values to trigger `||` fallbacks in connect()
        const rq: any = new RedisQueue('ConnFallbacks', {
            logger,
            port: 0 as unknown as number,   // falsy to trigger 6379 fallback
            host: '' as unknown as string,  // falsy to trigger 'localhost' fallback
            prefix: '' as unknown as string, // falsy to trigger '' fallback in connectionName
            cleanup: false,
        }, IMQMode.BOTH);

        await rq.start();

        // Basic sanity: writer/reader/watcher are created
        expect(Boolean(rq.writer)).to.equal(true);
        expect(Boolean(rq.reader)).to.equal(true);
        expect(Boolean(rq.watcher)).to.equal(true);

        await rq.destroy();
    });
});
