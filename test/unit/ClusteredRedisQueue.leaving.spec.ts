/*!
 * ClusteredRedisQueue Unit Tests: a server that announced it is leaving
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
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClusteredRedisQueue } from '../../src/index.js';
import { ClusterManager } from '../../src/ClusterManager.js';

const leaving = { host: '127.0.0.1', port: 7777 };
const staying = { host: '127.0.0.1', port: 8888 };

// the lapse checks run on mocked setTimeout; promise callbacks and
// setImmediate are left real, so this lets an answered PING land
const flush = () => new Promise(resolve => setImmediate(resolve));

const setAvailable = (imq: any, available: boolean): void => {
    Object.defineProperty(imq, 'available', {
        configurable: true,
        get: () => available,
    });
};

/**
 * A cluster of two ready servers, the first of which answers every PING, with
 * the send and publish of each recorded rather than performed.
 */
const fleet = (name: string) => {
    const cq: any = new ClusteredRedisQueue(name, {
        logger,
        clusterManagers: [new (ClusterManager as any)()],
    });

    cq.addServer(leaving);
    cq.addServer(staying);

    const [first, second] = cq.imqs;
    const routed: number[] = [];

    for (const [index, imq] of [first, second].entries()) {
        setAvailable(imq, true);
        mock.method(imq, 'send', async () => {
            routed.push(index);

            return 'id';
        });
        mock.method(imq, 'publish', async () => {
            routed.push(index);
        });
    }

    const answers = mock.method(first, 'answers', async () => true);
    const drain = mock.method(first, 'drain', async () => undefined);
    const destroy = mock.method(first, 'destroy', async () => undefined);

    return { cq, first, second, routed, answers, drain, destroy };
};

describe('ClusteredRedisQueue - a server that announced it is leaving', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('is kept and still read while it answers', async () => {
        const { cq, first, answers, drain, destroy } = fleet('TestLeavingKept');

        cq.removeServer(leaving, { leaving: true });
        await flush();

        assert.equal(answers.mock.callCount(), 1, 'it was never asked');
        assert.ok(cq.imqs.includes(first), 'a leaving broker was dropped');
        assert.equal(cq.servers.length, 2);
        assert.equal(drain.mock.callCount(), 0);
        assert.equal(destroy.mock.callCount(), 0, 'its reader was torn down');

        await cq.destroy();
    });

    it('takes no sends while another server can take them', async () => {
        const { cq, routed } = fleet('TestLeavingSend');

        cq.removeServer(leaving, { leaving: true });

        for (let i = 0; i < 4; i++) {
            await cq.send('Target', { i });
        }

        assert.deepEqual(routed, [1, 1, 1, 1]);

        await cq.destroy();
    });

    it('takes no publishes while another server can take them', async () => {
        const { cq, routed } = fleet('TestLeavingPublish');

        cq.removeServer(leaving, { leaving: true });

        for (let i = 0; i < 4; i++) {
            await cq.publish({ i });
        }

        assert.deepEqual(routed, [1, 1, 1, 1]);

        await cq.destroy();
    });

    it('still takes a send where every other server is down', async () => {
        const { cq, second, routed } = fleet('TestLeavingLastResort');

        setAvailable(second, false);
        cq.removeServer(leaving, { leaving: true });
        await cq.send('Target', {});
        await cq.publish({});

        assert.deepEqual(
            routed,
            [0, 0],
            'a message went to a server known to be down rather than to one still serving',
        );

        await cq.destroy();
    });

    it('is drained and dropped once it stops answering', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const { cq, first, answers, drain } = fleet('TestLeavingGone');
        const verdicts = [true, false];

        answers.mock.mockImplementation(async () => verdicts.shift());
        cq.removeServer(leaving, { leaving: true });
        await flush();
        assert.ok(cq.imqs.includes(first));

        // a `down` carries no interval, so it is asked at the default
        t.mock.timers.tick(1000);
        await flush();

        assert.equal(answers.mock.callCount(), 2);
        assert.ok(!cq.imqs.includes(first), 'a silent leaving broker stayed');
        assert.equal(cq.servers.length, 1);
        assert.equal(drain.mock.callCount(), 1, 'it was not drained first');
        assert.equal(cq.keptServers.size, 0);

        t.mock.timers.reset();
        await cq.destroy();
    });

    it('is back in routing once it announces itself again', async () => {
        const { cq, routed } = fleet('TestLeavingReturns');

        cq.removeServer(leaving, { leaving: true });
        await flush();
        cq.addServer(leaving);
        assert.equal(cq.keptServers.size, 0);

        for (let i = 0; i < 4; i++) {
            await cq.send('Target', { i });
        }

        assert.deepEqual(routed.sort(), [0, 0, 1, 1]);

        await cq.destroy();
    });

    it('leaves routing where it was kept after a lapse and then says it is leaving', async () => {
        const { cq, answers, routed } = fleet('TestLapsedThenLeaving');

        cq.removeServer(leaving, { lapsed: true });
        await flush();
        await cq.send('Target', {});
        await cq.send('Target', {});
        assert.deepEqual(routed.sort(), [0, 1], 'a lapsed broker left routing');

        routed.length = 0;
        cq.removeServer(leaving, { leaving: true });
        await flush();

        for (let i = 0; i < 4; i++) {
            await cq.send('Target', { i });
        }

        assert.deepEqual(routed, [1, 1, 1, 1]);
        assert.equal(
            answers.mock.callCount(),
            1,
            'a second report started a second chain of checks',
        );

        await cq.destroy();
    });

    it('stays out of routing when its announcements lapse as well', async () => {
        const { cq, routed } = fleet('TestLeavingThenLapsed');

        cq.removeServer(leaving, { leaving: true });
        cq.removeServer(leaving, { lapsed: true });
        await flush();

        for (let i = 0; i < 4; i++) {
            await cq.send('Target', { i });
        }

        assert.deepEqual(routed, [1, 1, 1, 1]);

        await cq.destroy();
    });

    it('ignores a server the cluster does not have', async () => {
        const { cq, answers } = fleet('TestLeavingUnknown');

        cq.removeServer({ host: '127.0.0.1', port: 9999 }, { leaving: true });
        await flush();

        assert.equal(cq.servers.length, 2);
        assert.equal(cq.keptServers.size, 0);
        assert.equal(answers.mock.callCount(), 0);

        await cq.destroy();
    });
});
