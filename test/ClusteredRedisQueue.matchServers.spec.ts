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

    it('should use strict logic when strict=true', () => {
        // same id and same address -> true
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'a', host: 'h', port: 1 }, true)).to.be.true;
        // same id but different address -> false
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'a', host: 'h', port: 2 }, true)).to.be.false;
        // different id but same address -> false
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'b', host: 'h', port: 1 }, true)).to.be.false;
    });

    it('should use relaxed logic when strict=false', () => {
        // id matches -> true even if address differs
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'a', host: 'h', port: 2 }, false)).to.be.true;
        // address matches -> true even if id differs
        expect(match({ id: 'a', host: 'h', port: 1 }, { id: 'b', host: 'h', port: 1 }, false)).to.be.true;
    });
});
