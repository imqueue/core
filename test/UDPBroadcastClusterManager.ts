/*!
 * RedisQueue Unit Tests
 *
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
// import * as mocks from './mocks';
import { expect } from 'chai';
import { UDPBroadcastClusterManager } from '../src';
import * as sinon from 'sinon';

const testMessageUp = 'name\tid\tup\taddress\ttimeout';
const testMessageDown = 'name\tid\tdown\taddress\ttimeout';

describe('UDPBroadcastClusterManager', function() {
    it('should be a class', () => {
        expect(typeof UDPBroadcastClusterManager).to.equal('function');
    });

    it('should initialize socket if socket does not exists', () => {
        (UDPBroadcastClusterManager as any).socket = undefined;

        new UDPBroadcastClusterManager();

        expect((UDPBroadcastClusterManager as any).socket).not.to.be.undefined;
    });

    it('should call add on cluster', () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPBroadcastClusterManager();

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        (UDPBroadcastClusterManager as any).socket.emit(
            'message',
            Buffer.from(testMessageUp),
        );

        expect(cluster.add.called).to.be.true;
    });

    it('should not call add on cluster if server exists', () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {
                return {};
            },
        };
        const manager: any = new UDPBroadcastClusterManager();

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        (UDPBroadcastClusterManager as any).socket.emit(
            'message',
            Buffer.from(testMessageUp),
        );

        expect(cluster.add.called).to.be.false;
    });

    it('should call remove on cluster', () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {
                return {};
            },
        };
        const manager: any = new UDPBroadcastClusterManager();

        sinon.spy(cluster, 'remove');

        manager.init(cluster);

        (UDPBroadcastClusterManager as any).socket.emit(
            'message',
            Buffer.from(testMessageDown),
        );

        expect(cluster.remove.called).to.be.true;
    });

    it('should add server if localhost included', () => {
       const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPBroadcastClusterManager({
            includeHosts: 'localhost',
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        (UDPBroadcastClusterManager as any).socket.emit(
            'message',
            Buffer.from('name\tid\tup\t127.0.0.1:6379\ttimeout'),
        );

        expect(cluster.add.called).to.be.true;
    });

    it('should not add server if localhost excluded', () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPBroadcastClusterManager({
            excludeHosts: 'localhost',
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        (UDPBroadcastClusterManager as any).socket.emit(
            'message',
            Buffer.from('name\tid\tup\t127.0.0.1:6379\ttimeout'),
        );

        expect(cluster.add.called).to.be.false;
    });
});
