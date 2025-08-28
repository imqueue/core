/*!
 * ClusterManager additional tests
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ClusterManager, InitializedCluster } from '../src/ClusterManager';

class TestClusterManager extends ClusterManager {
    public destroyed = false;
    public constructor() { super(); }
    public async destroy(): Promise<void> {
        this.destroyed = true;
    }
}

describe('ClusterManager.remove()', () => {
    it('should call destroy when the last cluster is removed and destroy=true', async () => {
        const cm = new TestClusterManager();
        const cluster: InitializedCluster = cm.init({
            add: () => ({} as any),
            remove: () => undefined,
            find: () => undefined,
        });

        // sanity: one cluster registered
        expect((cm as any).clusters.length).to.equal(1);
        const spy = sinon.spy(cm, 'destroy');

        await cm.remove(cluster, true);

        expect(spy.calledOnce).to.be.true;
        expect((cm as any).clusters.length).to.equal(0);
        expect(cm.destroyed).to.be.true;
    });

    it('should not call destroy when destroy=false', async () => {
        const cm = new TestClusterManager();
        const cluster: InitializedCluster = cm.init({
            add: () => ({} as any),
            remove: () => undefined,
            find: () => undefined,
        });

        const spy = sinon.spy(cm, 'destroy');
        await cm.remove(cluster.id, false);

        expect(spy.called).to.be.false;
        expect((cm as any).clusters.length).to.equal(0);
    });
});
