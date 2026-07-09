/*!
 * ClusterManager additional tests
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com
 */
import '../mocks/index.js';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterManager, type InitializedCluster } from '../../src/ClusterManager.js';

class TestClusterManager extends ClusterManager {
    public destroyed = false;
    public constructor() {
        super();
    }
    public async destroy(): Promise<void> {
        this.destroyed = true;
    }
}

describe('ClusterManager.remove()', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('should call destroy when the last cluster is removed and destroy=true', async () => {
        const cm = new TestClusterManager();
        const cluster: InitializedCluster = cm.init({
            add: () => ({}) as any,
            remove: () => undefined,
            find: () => undefined,
        });

        // sanity: one cluster registered
        assert.equal((cm as any).clusters.length, 1);
        const spy = mock.method(cm, 'destroy');

        await cm.remove(cluster, true);

        assert.equal(spy.mock.callCount(), 1);
        assert.equal((cm as any).clusters.length, 0);
        assert.equal(cm.destroyed, true);
    });

    it('should not call destroy when destroy=false', async () => {
        const cm = new TestClusterManager();
        const cluster: InitializedCluster = cm.init({
            add: () => ({}) as any,
            remove: () => undefined,
            find: () => undefined,
        });

        const spy = mock.method(cm, 'destroy');
        await cm.remove(cluster.id, false);

        assert.equal(spy.mock.callCount() > 0, false);
        assert.equal((cm as any).clusters.length, 0);
    });
});

describe('ClusterManager.forEachCluster()', () => {
    const makeCluster = () => ({
        add: () => ({}) as any,
        remove: () => undefined,
        find: () => undefined,
    });

    it('should apply the callback to every registered cluster', async () => {
        const cm = new TestClusterManager();
        const one = cm.init(makeCluster());
        const two = cm.init(makeCluster());
        const seen: string[] = [];

        await cm.forEachCluster(cluster => {
            seen.push(cluster.id);
        });

        assert.deepEqual(seen.sort(), [one.id, two.id].sort());
    });

    it('should process remaining clusters when one callback throws', async () => {
        const cm = new TestClusterManager();

        cm.init(makeCluster());
        cm.init(makeCluster());
        cm.init(makeCluster());

        let calls = 0;

        // a synchronous throw on the first cluster must not prevent the
        // remaining clusters from being processed, nor reject the call
        await cm.forEachCluster(() => {
            calls++;

            if (calls === 1) {
                throw new Error('first cluster callback failed');
            }
        });

        assert.equal(calls, 3);
    });
});
