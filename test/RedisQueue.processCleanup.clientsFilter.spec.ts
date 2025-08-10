/*!
 * Additional RedisQueue tests: processCleanup connectedKeys filter branches
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { RedisQueue, uuid } from '../src';

describe('RedisQueue.processCleanup connectedKeys RX/filter combinations', function() {
    this.timeout(5000);

    it('should handle RX_CLIENT_TEST true but filter false case (exclude unmatched prefix)', async () => {
        const name = `PCleanRX_${uuid()}`;
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imqA',
            cleanupFilter: '*',
        });

        await rq.start();

        const writer: any = rq.writer;

        // Stub client('LIST') to include a writer channel with a different prefix,
        // so RX_CLIENT_TEST.test(name) is true but filter.test(name) is false.
        const clientStub = sinon.stub(writer, 'client');
        clientStub.callsFake(async (cmd: string) => {
            if (cmd === 'LIST') {
                return [
                    'id=1 name=imqZ:Other:writer:pid:1:host:x', // RX true, filter false
                    'id=2 name=imqA:Other:subscription:pid:1:host:x', // RX false, filter true
                ].join('\n');
            }
            return true as any;
        });

        // Return no keys on SCAN to avoid deletions and just walk the branch
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
