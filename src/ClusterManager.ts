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
import { uuid } from './uuid';

export interface ICluster {
    add: (server: IServerInput) => void;
    remove: (server: IServerInput) => void;
    find: <T extends IMessageQueueConnection>(
        server: IServerInput,
    ) => T | undefined;
}

export interface InitializedCluster extends ICluster {
    id: string;
}

export abstract class ClusterManager {
    protected clusters: InitializedCluster[] = [];

    protected constructor() {}

    public init(cluster: ICluster): InitializedCluster {
        const initializedCluster = Object.assign(cluster, { id: uuid() });

        this.clusters.push(initializedCluster);

        return initializedCluster;
    }

    public async remove(
        cluster: string | InitializedCluster,
        destroy: boolean = true,
    ): Promise<void> {
        const id = typeof cluster === 'string' ? cluster : cluster.id;

        this.clusters = this.clusters.filter(cluster => cluster.id !== id);

        if (
            this.clusters.length === 0
            && destroy
            && typeof this.destroy === 'function'
        ) {
            await this.destroy();
        }
    }

    public abstract destroy(): Promise<void>;
}
