/*!
 * ClusteredRedisQueue Unit Tests: one publish goes to one server of the fleet
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
import { logger } from '../mocks/index.js';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    ClusteredRedisQueue,
    type IServerInput,
    type JsonObject,
    RedisQueue,
} from '../../src/index.js';
import { ClusterManager } from '../../src/ClusterManager.js';

/**
 * A cluster manager the test drives by hand: every queue built on it learns
 * of a server at the moment the test announces it.
 */
class ScriptedManager extends ClusterManager {
    public constructor() {
        super();
    }

    public announce(server: IServerInput): void {
        for (const cluster of this.clusters) {
            cluster.add(server);
        }
    }

    public async destroy(): Promise<void> {}
}

/**
 * Stands in for the brokers: a subscription is held per server, and a
 * publish on a server reaches exactly the handlers subscribed on that server,
 * as redis pub/sub does.
 */
const brokers = () => {
    const channels = new Map<string, Array<(data: JsonObject) => void>>();
    const published: string[] = [];
    const failing = new Set<string>();
    const on = (key: string) => {
        if (!channels.has(key)) {
            channels.set(key, []);
        }

        return channels.get(key)!;
    };

    mock.method(
        RedisQueue.prototype,
        'subscribe',
        async function (
            this: RedisQueue,
            _channel: string,
            handler: (data: JsonObject) => void,
        ) {
            on(this.redisKey).push(handler);
        },
    );
    mock.method(
        RedisQueue.prototype,
        'unsubscribe',
        async function (this: RedisQueue) {
            channels.delete(this.redisKey);
        },
    );
    mock.method(
        RedisQueue.prototype,
        'publish',
        async function (this: RedisQueue, data: JsonObject) {
            if (failing.has(this.redisKey)) {
                throw new Error('connection lost');
            }

            published.push(this.redisKey);

            for (const handler of on(this.redisKey)) {
                handler(data);
            }
        },
    );

    return { published, failing };
};

const settled = (ms = 0): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

const brokerA = { id: 'a', host: '127.0.0.1', port: 7101 };
const brokerB = { id: 'b', host: '127.0.0.1', port: 7102 };

describe('ClusteredRedisQueue.publish() over a fleet of brokers', () => {
    let manager: ScriptedManager;
    let queues: ClusteredRedisQueue[];

    // a pod: one clustered queue on the shared manager
    const pod = (
        name: string,
        options: Record<string, unknown> = {},
    ): ClusteredRedisQueue => {
        const queue = new ClusteredRedisQueue(name, {
            clusterManagers: [manager],
            logger,
            publishSettleTime: 0,
            ...options,
        });

        queues.push(queue);

        return queue;
    };

    beforeEach(() => {
        manager = new ScriptedManager();
        queues = [];
    });

    afterEach(async () => {
        await Promise.all(queues.map(queue => queue.destroy()));
        mock.restoreAll();
    });

    it('delivers one publish to each subscriber exactly once', async () => {
        brokers();

        const publisher = pod('Publisher');
        const first = pod('Gateway');
        const second = pod('Gateway');
        const firstHandler = mock.fn();
        const secondHandler = mock.fn();

        await first.subscribe('Events', firstHandler);
        await second.subscribe('Events', secondHandler);
        manager.announce(brokerA);
        manager.announce(brokerB);
        await settled();

        await publisher.publish({ event: 1 }, 'Events');

        assert.equal(firstHandler.mock.callCount(), 1);
        assert.equal(secondHandler.mock.callCount(), 1);
        assert.deepEqual(firstHandler.mock.calls[0].arguments, [{ event: 1 }]);
    });

    it('keeps the fan-out where publishFanOut asks for it', async () => {
        const { published } = brokers();

        const publisher = pod('Publisher', { publishFanOut: true });
        const subscriber = pod('Gateway');
        const handler = mock.fn();

        await subscriber.subscribe('Events', handler);
        manager.announce(brokerA);
        manager.announce(brokerB);
        await settled();

        await publisher.publish({ event: 1 }, 'Events');

        assert.equal(handler.mock.callCount(), 2);
        assert.deepEqual(published.sort(), [
            '127.0.0.1:7101',
            '127.0.0.1:7102',
        ]);
    });

    it('spreads publishes across the brokers', async () => {
        const { published } = brokers();
        const publisher = pod('Publisher');

        manager.announce(brokerA);
        manager.announce(brokerB);

        for (let i = 0; i < 4; i++) {
            await publisher.publish({ event: i }, 'Events');
        }

        assert.deepEqual(published, [
            '127.0.0.1:7101',
            '127.0.0.1:7102',
            '127.0.0.1:7101',
            '127.0.0.1:7102',
        ]);
    });

    it('skips a broker whose connection is not ready', async () => {
        const { published } = brokers();
        const publisher: any = pod('Publisher');

        manager.announce(brokerA);
        manager.announce(brokerB);
        Object.defineProperty(publisher.imqs[0], 'available', {
            configurable: true,
            get: () => false,
        });

        await publisher.publish({ event: 1 }, 'Events');
        await publisher.publish({ event: 2 }, 'Events');

        assert.deepEqual(published, ['127.0.0.1:7102', '127.0.0.1:7102']);
    });

    it('does not choose a broker that just joined until it settles', async () => {
        const { published } = brokers();
        const publisher = pod('Publisher', { publishSettleTime: 60 });

        manager.announce(brokerA);
        await settled(80);
        manager.announce(brokerB);

        for (let i = 0; i < 3; i++) {
            await publisher.publish({ event: i }, 'Events');
        }

        assert.deepEqual(published, [
            '127.0.0.1:7101',
            '127.0.0.1:7101',
            '127.0.0.1:7101',
        ]);

        await settled(80);
        published.length = 0;
        await publisher.publish({ event: 3 }, 'Events');
        await publisher.publish({ event: 4 }, 'Events');

        assert.deepEqual(published.sort(), [
            '127.0.0.1:7101',
            '127.0.0.1:7102',
        ]);
    });

    it('uses a broker that just joined where it is the only one', async () => {
        const { published } = brokers();
        const publisher = pod('Publisher', { publishSettleTime: 60_000 });

        manager.announce(brokerA);
        await publisher.publish({ event: 1 }, 'Events');

        assert.deepEqual(published, ['127.0.0.1:7101']);
    });

    it('treats statically configured brokers as settled', async () => {
        const { published } = brokers();
        const publisher = new ClusteredRedisQueue('Static', {
            cluster: [brokerA, brokerB],
            logger,
            publishSettleTime: 60_000,
        });

        queues.push(publisher);
        await publisher.publish({ event: 1 }, 'Events');
        await publisher.publish({ event: 2 }, 'Events');

        assert.deepEqual(published, ['127.0.0.1:7101', '127.0.0.1:7102']);
    });

    it('falls over to another broker when the chosen one fails', async () => {
        const { published, failing } = brokers();
        const publisher = pod('Publisher');
        const subscriber = pod('Gateway');
        const handler = mock.fn();

        await subscriber.subscribe('Events', handler);
        manager.announce(brokerA);
        manager.announce(brokerB);
        await settled();
        failing.add('127.0.0.1:7101');

        await publisher.publish({ event: 1 }, 'Events');

        assert.deepEqual(published, ['127.0.0.1:7102']);
        assert.equal(handler.mock.callCount(), 1);
    });

    it('rejects when the broker taken over also fails', async () => {
        const { failing } = brokers();
        const publisher = pod('Publisher');

        manager.announce(brokerA);
        manager.announce(brokerB);
        failing.add('127.0.0.1:7101');
        failing.add('127.0.0.1:7102');

        await assert.rejects(
            publisher.publish({ event: 1 }, 'Events'),
            /connection lost/,
        );
    });

    it('rejects when no other broker is ready to take over', async () => {
        const { failing } = brokers();
        const publisher: any = pod('Publisher');

        manager.announce(brokerA);
        manager.announce(brokerB);
        failing.add('127.0.0.1:7101');
        Object.defineProperty(publisher.imqs[1], 'available', {
            configurable: true,
            get: () => false,
        });

        await assert.rejects(
            publisher.publish({ event: 1 }, 'Events'),
            /connection lost/,
        );
    });

    it('reports a failing broker once, until it publishes again', async () => {
        const { failing } = brokers();
        const warn: string[] = [];
        const publisher: any = pod('Publisher', {
            logger: { ...logger, warn: (line: string) => warn.push(line) },
        });

        manager.announce(brokerA);
        failing.add('127.0.0.1:7101');

        await assert.rejects(publisher.publish({ event: 1 }, 'Events'));
        await assert.rejects(publisher.publish({ event: 2 }, 'Events'));
        assert.equal(
            warn.filter(line => /failed to publish/.test(line)).length,
            1,
        );

        failing.delete('127.0.0.1:7101');
        await publisher.publish({ event: 3 }, 'Events');
        failing.add('127.0.0.1:7101');
        await assert.rejects(publisher.publish({ event: 4 }, 'Events'));

        assert.equal(
            warn.filter(line => /failed to publish/.test(line)).length,
            2,
        );
        assert.equal(
            warn.some(line => line.includes('event')),
            false,
        );
    });
});
