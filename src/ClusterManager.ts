/*!
 * Clustered messaging queue over Redis implementation
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
import { randomUUID } from 'node:crypto';
import {
    type IMessageQueueConnection,
    type IServerInput,
} from './IMessageQueue.js';

/**
 * Membership callbacks a clustered queue hands to a {@link ClusterManager} so
 * the manager can add and remove servers as it discovers them.
 *
 * Implement this to feed a clustered queue from your own discovery mechanism;
 * {@link ClusteredRedisQueue} supplies an implementation of its own.
 */
export interface ICluster {
    /**
     * Adds a server to the cluster and returns its registration record.
     * Registration is idempotent — an already-known server is returned
     * unchanged.
     */
    add: (server: IServerInput) => IMessageQueueConnection;
    /**
     * Removes a server from the cluster. A no-op when the server is unknown.
     */
    remove: (server: IServerInput) => void;
    /**
     * Looks a server up, matching by `id` when both sides carry one and by host
     * and port otherwise. Returns `undefined` when it is not registered.
     */
    find: (server: IServerInput) => IMessageQueueConnection | undefined;
}

/**
 * A cluster that has been registered with a {@link ClusterManager}, carrying
 * the generated id that identifies it for {@link ClusterManager.remove}.
 */
export interface InitializedCluster extends ICluster {
    /**
     * Identifier generated when the cluster was registered.
     */
    id: string;
}

/**
 * Abstract base for cluster-membership discovery. A manager tracks the clusters
 * it feeds and pushes server add/remove events into each of them, so several
 * clustered queues can share one discovery mechanism.
 *
 * Supply instances through {@link IMQOptions.clusterManagers}.
 * {@link UDPClusterManager} is the implementation shipped with the framework.
 *
 * @remarks
 * Subclasses must implement {@link ClusterManager.destroy} to release their
 * transport, and that implementation must be idempotent — `remove()` can invoke
 * it more than once.
 */
export abstract class ClusterManager {
    /**
     * Clusters currently registered with this manager.
     */
    protected clusters: InitializedCluster[] = [];

    protected constructor() {}

    /**
     * Registers a cluster's membership callbacks with this manager and returns
     * an identified handle.
     *
     * @param cluster - the membership callbacks to feed
     * @returns the registered cluster, carrying the id that
     *          {@link ClusterManager.remove} accepts
     *
     * @remarks
     * Retain the returned handle (or its `id`) — it is the only thing `remove()`
     * accepts. Registering does not start discovery: an implementation may
     * already be listening from construction, in which case events that arrive
     * before this call are discarded.
     */
    public init(cluster: ICluster): InitializedCluster {
        const initializedCluster: InitializedCluster = {
            ...cluster,
            id: randomUUID(),
        };

        this.clusters.push(initializedCluster);

        return initializedCluster;
    }

    /**
     * Applies the given callback to every registered cluster. Each cluster
     * is handled independently: a callback that throws (synchronously or
     * asynchronously) for one cluster never prevents the remaining clusters
     * from being processed.
     *
     * @param fn - callback to apply to each registered cluster
     *
     * @remarks
     * Callback failures are discarded: the returned promise always resolves and
     * errors are neither rethrown nor logged, so callbacks must handle and
     * report their own failures.
     */
    public async forEachCluster(
        fn: (cluster: InitializedCluster) => Promise<void> | void,
    ): Promise<void> {
        await Promise.allSettled(
            this.clusters.map(async cluster => fn(cluster)),
        );
    }

    /**
     * Unregisters a cluster from this manager.
     *
     * @param cluster - the cluster handle returned by {@link ClusterManager.init},
     *        or its `id`
     * @param destroy - when true (the default), destroy the manager once no
     *        clusters remain; pass false to unregister without tearing it down
     *
     * @remarks
     * Unregistering the last cluster destroys the manager and releases its
     * transport — for {@link UDPClusterManager} that means shutting down the
     * shared broadcast worker. Calling this with an unknown id while no clusters
     * remain also triggers that shutdown, which is why `destroy()`
     * implementations must be idempotent.
     */
    public async remove(
        cluster: string | InitializedCluster,
        destroy: boolean = true,
    ): Promise<void> {
        const id = typeof cluster === 'string' ? cluster : cluster.id;

        this.clusters = this.clusters.filter(cluster => cluster.id !== id);

        if (
            this.clusters.length === 0 &&
            destroy &&
            typeof this.destroy === 'function'
        ) {
            await this.destroy();
        }
    }

    /**
     * Releases the manager's transport. Implemented by subclasses, and must be
     * safe to call more than once.
     */
    public abstract destroy(): Promise<void>;
}
