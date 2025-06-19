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
import { expect } from 'chai';
import { UDPBroadcastClusterManager } from '../src';
import * as sinon from 'sinon';
import { Socket } from 'dgram';

const testMessageUp = 'name\tid\tup\taddress\ttimeout';
const testMessageDown = 'name\tid\tdown\taddress\ttimeout';

const getSocket = (classObject: typeof UDPBroadcastClusterManager) => {
    return Object.values((classObject as any).sockets)[0] as Socket;
};

const emitMessage = (message: string) => {
    getSocket(UDPBroadcastClusterManager).emit('message', Buffer.from(message));
};

describe('UDPBroadcastClusterManager', function() {
    it('should be a class', () => {
        expect(typeof UDPBroadcastClusterManager).to.equal('function');
    });

    it('should initialize socket if socket does not exists', () => {
        (UDPBroadcastClusterManager as any).sockets = {};

        new UDPBroadcastClusterManager();

        expect(
            Object.values((UDPBroadcastClusterManager as any).sockets),
        ).not.to.be.length(0);
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

        emitMessage(testMessageUp);
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
        new UDPBroadcastClusterManager();

        sinon.spy(cluster, 'add');

        emitMessage(testMessageUp);
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

        emitMessage(testMessageDown);
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

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
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

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
        expect(cluster.add.called).to.be.false;
    });
});
