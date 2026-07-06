/*!
 * Tests for ClusteredRedisQueue.matchServers combinations
 */
import '../../mocks';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusteredRedisQueue } from '../../../src';

// Access private static via casting
const match = (ClusteredRedisQueue as any).matchServers as (
    source: any,
    target: any,
    strict?: boolean,
) => boolean;

describe('ClusteredRedisQueue.matchServers()', () => {
    it('should return sameAddress when no ids provided', () => {
        assert.equal(
            match({ host: 'h', port: 1 }, { host: 'h', port: 1 }),
            true,
        );
        assert.equal(
            match({ host: 'h', port: 1 }, { host: 'h', port: 2 }),
            false,
        );
    });

    it('should match servers if id provided', () => {
        assert.equal(
            match(
                { id: 'a', host: 'h', port: 1 },
                { id: 'a', host: 'h', port: 2 },
            ),
            true,
        );
        assert.equal(
            match(
                { id: 'a', host: 'h', port: 1 },
                { id: 'b', host: 'h', port: 1 },
            ),
            true,
        );
    });
});
