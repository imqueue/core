/*!
 * Additional RedisQueue tests: processCleanup branches (connectedKeys filter,
 * extra prefix, multi-scan/no-delete, null-match and falsy cleanupFilter)
 */
import '../../mocks';
import { describe, it, afterEach, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { RedisQueue, uuid } from '../../../src';
import { RedisClientMock } from '../../mocks';

describe('RedisQueue.processCleanup connectedKeys RX/filter combinations', () => {
    afterEach(() => {
        mock.restoreAll();
    });

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
        mock.method(writer, 'client', async (cmd: string) => {
            if (cmd === 'LIST') {
                return [
                    'id=1 name=imqZ:Other:writer:pid:1:host:x', // RX true, filter false
                    'id=2 name=imqA:Other:subscription:pid:1:host:x', // RX false, filter true
                ].join('\n');
            }
            return true as any;
        });

        // Return no keys on SCAN to avoid deletions and just walk the branch
        mock.method(writer, 'scan', async () => ['0', []] as any);

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup extra branches', () => {
    it('should remove scanned keys that do not match any connectedKey (different prefix)', async () => {
        const name = uuid();
        const rq: any = new RedisQueue(name, {
            logger: console,
            cleanup: true,
            prefix: 'imqX',
            cleanupFilter: '*',
        });

        // start to create reader/writer/watcher with connection names
        await rq.start();

        // Create an orphan worker key with a different prefix so it won't include any connectedKey
        const orphanKey = 'imqY:orphan:worker:someuuid:123456';
        (RedisClientMock as any).__queues__[orphanKey] = ['payload'];

        // Sanity: ensure the key is present before cleanup
        assert.ok((RedisClientMock as any).__queues__[orphanKey]);

        await rq.processCleanup();

        // The orphan key should be deleted by cleanup (true branch of keysToRemove filter)
        assert.equal((RedisClientMock as any).__queues__[orphanKey], undefined);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup multi-scan/no-delete branches', () => {
    afterEach(() => {
        mock.restoreAll();
    });

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
        const scanStub: Mock<any> = mock.method(
            writer,
            'scan',
            async () => undefined,
        );
        scanStub.mock.mockImplementationOnce(
            async () => ['1', undefined] as any,
            0,
        );
        scanStub.mock.mockImplementationOnce(
            async () => ['0', [`imq:${name}:reader:pid:123`]] as any,
            1,
        );

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        // del should not be called because keysToRemove.length === 0
        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});

describe('RedisQueue.processCleanup null-match and falsy cleanupFilter', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it("should handle clients.match returning null and cleanupFilter as falsy ('')", async () => {
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
        mock.method(writer, 'client', async (cmd: string) => {
            if (cmd === 'LIST') {
                return 'id=1 flags=x'; // no 'name='
            }
            return true as any;
        });

        // Ensure SCAN returns no keys, to avoid deletions and just cover the branch paths
        mock.method(writer, 'scan', async () => ['0', []] as any);

        const delSpy: Mock<any> = mock.method(writer, 'del');

        await rq.processCleanup();

        assert.equal(delSpy.mock.callCount() > 0, false);

        await rq.destroy();
    });
});
