/*!
 * uuid() Function Unit Tests
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
import { expect } from 'chai';
import { uuid } from '..';

describe('uuid()', function() {
    this.timeout(10000); // 10 seconds

    const steps = 100000;

    it('should always match RFC4122 spec', () => {
        const regex = new RegExp(
            '^' +
            '[0-9a-f]{8}' +
            '-' +
            '[0-9a-f]{4}' +
            '-' +
            '[1-5][0-9a-f]{3}' +
            '-' +
            '[89ab][0-9a-f]{3}' +
            '-' +
            '[0-9a-f]{12}' +
            '$',
            'i',
        );

        for (let i = 0; i < 1000; i++) {
            expect(regex.test(uuid())).to.be.true;
        }
    });

    it('should be unique each time generated (100,000 samples)', () => {
        const keyStore: { [name: string]: number } = {};

        for (let i = 0; i < steps; i++) {
            keyStore[uuid()] = 1;
        }

        expect(Object.keys(keyStore).length).to.be.equal(steps);
    });

    it('should generate 100,000 identifiers in less than a second', () => {
        const start = Date.now();

        for (let i = 0; i < steps; i++) {
            uuid();
        }

        expect(Date.now() - start).to.be.below(1000);
    });
});
