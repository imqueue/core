/*!
 * Tests for ClusteredRedisQueue.matchServers combinations
 */
import './mocks';
import { expect } from 'chai';
import { ClusteredRedisQueue } from '../src';

// Access private static via casting
const match = (ClusteredRedisQueue as any).matchServers as (
    source: any, target: any, strict?: boolean
) => boolean;

describe('ClusteredRedisQueue.matchServers()', () => {
    it('should return sameAddress when no ids provided', () => {
        expect(match({ host: 'h', port: 1 }, { host: 'h', port: 1 })).to.be.true;
        expect(match({ host: 'h', port: 1 }, { host: 'h', port: 2 })).to.be.false;
    });

    it('should match servers if id provided', () => {
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'a', host: 'h', port: 2 })).to.be.true;
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'b', host: 'h', port: 1 })).to.be.true;
    });
});
