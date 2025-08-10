/*!
 * Additional RedisQueue tests for processCleanup branches: clients.match null and cleanupFilter falsy
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue, uuid } from '../src';

describe('RedisQueue.processCleanup null-match and falsy cleanupFilter', function() {
    this.timeout(5000);

    it('should handle clients.match returning null and cleanupFilter as falsy (\'\')', async () => {
        const name = `PCleanNull_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imq',
            cleanupFilter: '', // falsy to exercise "|| '*'" in both RegExp and SCAN MATCH
        });

        await rq.start();

        const writer: any = rq.writer;

        // Force clients.match(...) to return null by stubbing client('LIST') to return a string without 'name='
        const clientStub = sinon.stub(writer, 'client');
        clientStub.callsFake(async (cmd: string) => {
            if (cmd === 'LIST') {
                return 'id=1 flags=x'; // no 'name='
            }
            return true as any;
        });

        // Ensure SCAN returns no keys, to avoid deletions and just cover the branch paths
        const scanStub = sinon.stub(writer, 'scan');
        scanStub.resolves(['0', []] as any);

        const delSpy = sinon.spy(writer, 'del');

        await rq.processCleanup();

        expect(delSpy.called).to.equal(false);

        clientStub.restore();
        scanStub.restore();
        delSpy.restore();
        await rq.destroy();
    });
});
