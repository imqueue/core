/*!
 * RedisQueue Unit Tests
 *
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import { expect } from 'chai';
import { UDPClusterManager } from '../src';
import * as sinon from 'sinon';
import { Socket } from 'dgram';

const testMessageUp = 'name\tid\tup\taddress\ttimeout';
const testMessageDown = 'name\tid\tdown\taddress\ttimeout';

const getSocket = (classObject: typeof UDPClusterManager) => {
    return Object.values((classObject as any).sockets)[0] as Socket;
};

const emitMessage = (message: string) => {
    getSocket(UDPClusterManager).emit('message', Buffer.from(message));
};

describe('UDPBroadcastClusterManager', function() {
    it('should be a class', () => {
        expect(typeof UDPClusterManager).to.equal('function');
    });

    it('should initialize socket if socket does not exists', () => {
        (UDPClusterManager as any).sockets = {};

        new UDPClusterManager();

        expect(
            Object.values((UDPClusterManager as any).sockets),
        ).not.to.be.length(0);
    });

    it('should call add on cluster', () => {
        const cluster: any = {
            add: () => {},
            remove: () => {},
            find: () => {},
        };
        const manager: any = new UDPClusterManager();

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
        new UDPClusterManager();

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
        const manager: any = new UDPClusterManager();

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
        const manager: any = new UDPClusterManager({
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
        const manager: any = new UDPClusterManager({
            excludeHosts: 'localhost',
        });

        sinon.spy(cluster, 'add');

        manager.init(cluster);

        emitMessage('name\tid\tup\t127.0.0.1:6379\ttimeout');
        expect(cluster.add.called).to.be.false;
    });
});
