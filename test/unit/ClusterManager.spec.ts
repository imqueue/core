/*!
 * ClusterManager additional tests
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com
 */
import '../mocks';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterManager, InitializedCluster } from '../../src/ClusterManager';

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
