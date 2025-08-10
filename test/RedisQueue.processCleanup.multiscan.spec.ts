/*!
 * Additional RedisQueue tests for processCleanup branches: multi-scan and no-deletion path
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue, uuid } from '../src';

describe('RedisQueue.processCleanup multi-scan/no-delete branches', function() {
    this.timeout(5000);

    it('should handle multi-page SCAN (cursor != "0" first) and avoid deletion when keys belong to connected clients', async () => {
        const name = `PClean_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imq',
            cleanupFilter: '*',
        });

        await rq.start();

        const writer: any = rq.writer;

        // Stub scan to first return non-zero cursor with undefined keys (to exercise `|| []`),
        // then return zero cursor with keys that include connectedKey (so no removal happens).
        const scanStub = sinon.stub(writer, 'scan');
        scanStub.onCall(0).resolves(['1', undefined] as any);
        scanStub.onCall(1).resolves(['0', [`imq:${name}:reader:pid:123`]] as any);

        const delSpy = sinon.spy(writer, 'del');

        await rq.processCleanup();

        // del should not be called because keysToRemove.length === 0
        expect(delSpy.called).to.equal(false);

        scanStub.restore();
        delSpy.restore();
        await rq.destroy();
    });
});
