/*!
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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    pack,
    packer,
    unpackAny,
    ZSTD_AVAILABLE,
    ZSTD_MARK,
} from '../../../src/helpers/index.js';

const big = {
    id: 'm1',
    from: 'RecordsClient',
    message: {
        items: Array.from({ length: 2000 }, (_, at) => ({
            key: `field${at}`,
            name: `Field ${at}`,
            holds: 'TEXT',
        })),
    },
};
const small = { id: 'm2', from: 'RecordsClient', message: { ok: true } };

describe('packer()', () => {
    it('writes plain JSON when told nothing', () => {
        assert.equal(packer(false, 0)(big), JSON.stringify(big));
    });

    it('writes a message at or below the threshold as plain JSON', () => {
        const json = JSON.stringify(small);

        assert.equal(packer(false, json.length)(small), json);
    });

    it(
        'writes a message above the threshold as zstd, far smaller',
        { skip: !ZSTD_AVAILABLE },
        () => {
            const packed = packer(false, 1024)(big);

            assert.ok(packed.startsWith(ZSTD_MARK));
            assert.ok(packed.length * 5 < JSON.stringify(big).length);
            assert.deepEqual(unpackAny(packed), big);
        },
    );

    it('keeps gzip when it is asked for, whatever the threshold', () => {
        assert.equal(packer(true, 1024)(big), pack(big));
    });
});

describe('unpackAny()', () => {
    it('reads plain JSON', () => {
        assert.deepEqual(unpackAny(JSON.stringify(big)), big);
    });

    it('reads gzip', () => {
        assert.deepEqual(unpackAny(pack(big)), big);
    });

    it('refuses what is none of the three', () => {
        assert.throws(() => unpackAny('not a message'));
    });
});
