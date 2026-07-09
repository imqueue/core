/*!
 * UDPWorker Unit Tests
 *
 * I'm Queue Software Project
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
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import '../mocks';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// import-equals keeps the live (mocked) CJS module object (unlike
// `import * as`, which esModuleInterop turns into a copy), so patching
// os.networkInterfaces below is observed by the code under test
import os = require('node:os');
import { UDPWorker } from '../../src/UDPWorker';

const OPTIONS: any = {
    port: 63999,
    address: '255.255.255.255',
    limitedAddress: '255.255.255.255',
    aliveTimeoutCorrection: 5000,
    useAliveCheck: false,
};

const makePort = (): any => {
    const port: any = new EventEmitter();

    port.postMessage = mock.fn();

    return port;
};

const makeWorker = (options: any = OPTIONS): { worker: any; port: any } => {
    const port = makePort();
    const worker: any = new UDPWorker(options, port);

    return { worker, port };
};

const datagram = (...fields: Array<string | number>): Buffer =>
    Buffer.from(fields.join('\t'));

const postedMessages = (port: any): any[] =>
    port.postMessage.mock.calls.map((call: any) => call.arguments[0]);

describe('UDPWorker', () => {
    it('should post cluster:add for a valid up datagram', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-1', 'UP', '127.0.0.1:6379', '30'),
        );

        assert.deepEqual(postedMessages(port), [
            {
                type: 'cluster:add',
                server: {
                    id: 'id-1',
                    name: 'IMQ',
                    type: 'up',
                    host: '127.0.0.1',
                    port: 6379,
                    timeout: 30000,
                },
            },
        ]);
    });

    it('should post cluster:remove for a down datagram', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-1', 'down', '127.0.0.1:6379', '30'),
        );

        const [message] = postedMessages(port);

        assert.equal(message.type, 'cluster:remove');
        assert.equal(message.server.id, 'id-1');
    });

    it('should drop malformed datagrams without crashing', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit('message', Buffer.from('complete garbage'));
        worker.socket.emit('message', Buffer.from(''));
        worker.socket.emit('message', datagram('IMQ', 'id-1'));

        assert.equal(port.postMessage.mock.callCount(), 0);
    });

    it('should drop datagrams with a non-numeric or invalid port', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-1', 'up', '127.0.0.1:oops', '30'),
        );
        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-2', 'up', '127.0.0.1:0', '30'),
        );
        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-3', 'up', '127.0.0.1:70000', '30'),
        );

        assert.equal(port.postMessage.mock.callCount(), 0);
    });

    it('should drop datagrams with a non-numeric or negative timeout', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-1', 'up', '127.0.0.1:6379', 'NaN'),
        );
        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-2', 'up', '127.0.0.1:6379', '-5'),
        );

        assert.equal(port.postMessage.mock.callCount(), 0);
    });

    it('should forward socket errors to the main thread', () => {
        const { worker, port } = makeWorker();

        worker.socket.emit('error', new Error('EADDRINUSE'));

        assert.deepEqual(postedMessages(port), [
            { type: 'error', error: 'EADDRINUSE' },
        ]);
    });

    it('should reply with stopped on a stop message', () => {
        const { port } = makeWorker();

        port.emit('message', { type: 'stop' });

        assert.deepEqual(postedMessages(port), [{ type: 'stopped' }]);
    });

    it('should reply with stopped even without a socket', () => {
        const { worker, port } = makeWorker();

        worker.socket = undefined;
        port.emit('message', { type: 'stop' });

        assert.deepEqual(postedMessages(port), [{ type: 'stopped' }]);
    });

    it('should swallow errors thrown while handling a datagram', () => {
        const { worker, port } = makeWorker();

        // a null payload makes parseMessage throw inside the handler; the
        // worker must not crash and must not post anything
        assert.doesNotThrow(() => worker.socket.emit('message', null));
        assert.equal(port.postMessage.mock.callCount(), 0);
    });

    it('selects a matching IPv4 interface for the broadcast address', () => {
        const { worker } = makeWorker({
            ...OPTIONS,
            address: '127.0.0.255',
            limitedAddress: '255.255.255.255',
        });

        assert.equal(worker.selectNetworkInterface(), '127.0.0.1');
    });

    it('skips interface entries with no addresses', () => {
        const original = os.networkInterfaces;

        (os as any).networkInterfaces = () => ({
            empty: undefined,
            lo: [
                {
                    address: '127.0.0.1',
                    family: 'IPv4',
                    internal: true,
                },
            ],
        });

        try {
            const { worker } = makeWorker({
                ...OPTIONS,
                address: '127.0.0.255',
                limitedAddress: '255.255.255.255',
            });

            assert.equal(worker.selectNetworkInterface(), '127.0.0.1');
        } finally {
            (os as any).networkInterfaces = original;
        }
    });

    it('should remove a server after its alive timeout expires', async () => {
        const { worker, port } = makeWorker({
            ...OPTIONS,
            useAliveCheck: true,
            aliveTimeoutCorrection: 0,
        });

        worker.socket.emit(
            'message',
            datagram('IMQ', 'id-1', 'up', '127.0.0.1:6379', '0.001'),
        );

        await new Promise(resolve => setTimeout(resolve, 50));

        const types = postedMessages(port).map(message => message.type);

        assert.deepEqual(types, ['cluster:add', 'cluster:remove']);
    });

    it('should keep a server alive while heartbeats keep arriving', async () => {
        const { worker, port } = makeWorker({
            ...OPTIONS,
            useAliveCheck: true,
            aliveTimeoutCorrection: 0,
        });
        const heartbeat = (): void =>
            worker.socket.emit(
                'message',
                datagram('IMQ', 'id-1', 'up', '127.0.0.1:6379', '0.03'),
            );

        heartbeat();
        await new Promise(resolve => setTimeout(resolve, 15));
        // the fresh heartbeat re-stamps the server, invalidating the
        // previous liveness timer
        heartbeat();
        await new Promise(resolve => setTimeout(resolve, 15));

        const types = postedMessages(port).map(message => message.type);

        assert.deepEqual(types, ['cluster:add', 'cluster:add']);
    });
});
