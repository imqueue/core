/*!
 * UDPClusterManager parseBroadcastedMessage and startListening branch tests
 */
import './mocks';
import { expect } from 'chai';
import { UDPClusterManager } from '../src';

/**
 * Covers default parameters in startListening(options = {}) and
 * default destructuring for address = '' and timeout = '0' in
 * parseBroadcastedMessage().
 */
describe('UDPClusterManager parse/start branches', () => {
    it('parseBroadcastedMessage: should apply defaults for empty address and timeout', () => {
        const parse = (UDPClusterManager as any).parseBroadcastedMessage as Function;
        const buf = Buffer.from(['name', 'id', 'UP'].join('\t'));
        const msg = parse(buf);
        expect(msg).to.include({ name: 'name', id: 'id', type: 'up' });
        // address default => '' leads to host '' and port NaN
        expect(msg.host).to.equal('');
        expect(Number.isNaN(msg.port)).to.equal(true);
        // timeout default '0' => 0 ms
        expect(msg.timeout).to.equal(0);
    });

    it('startListening: should call listenBroadcastedMessages when called without options', () => {
        const mgr: any = new (UDPClusterManager as any)();
        let called = false;
        const original = mgr.listenBroadcastedMessages;
        mgr.listenBroadcastedMessages = (..._args: any[]) => { called = true; };
        try {
            (mgr as any).startListening();
            expect(called).to.equal(true);
        } finally {
            mgr.listenBroadcastedMessages = original;
        }
    });
});
