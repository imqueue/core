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
import { IMessageQueueConnection, IServerInput } from './IMessageQueue';
import { randomUUID } from 'node:crypto';

export interface ICluster {
    add: (server: IServerInput) => IMessageQueueConnection;
    remove: (server: IServerInput) => void;
    find: (server: IServerInput) => IMessageQueueConnection | undefined;
}

export interface InitializedCluster extends ICluster {
    id: string;
}

export abstract class ClusterManager {
    protected clusters: InitializedCluster[] = [];

    protected constructor() {}

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
     * @param {(cluster: InitializedCluster) => Promise<void> | void} fn
     * @returns {Promise<void>}
     */
    public async forEachCluster(
        fn: (cluster: InitializedCluster) => Promise<void> | void,
    ): Promise<void> {
        await Promise.allSettled(
            this.clusters.map(async cluster => fn(cluster)),
        );
    }

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

    public abstract destroy(): Promise<void>;
}
