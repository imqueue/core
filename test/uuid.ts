/*!
 * uuid() Function Unit Tests
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import { expect } from 'chai';
import { uuid } from '..';

describe('uuid()', function() {
    this.timeout(10000); // 10 seconds

    const steps = 100000;

    it('should always match RFC4122 spec', () => {
        let regex = new RegExp(
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
            'i'
        );

        for (let i = 0; i < 1000; i++) {
            expect(regex.test(uuid())).to.be.true;
        }
    });

    it('should be unique each time generated', () => {
        const keyStore: { [name: string]: number } = {};

        for (let i = 0; i < steps; i++) {
            keyStore[uuid()] = 1;
        }

        expect(Object.keys(keyStore).length).to.be.equal(steps);
    });

    it('should generate 100,000 identifiers in less than a second', () => {
        const start = Date.now();

        for (let i = 0, id; i < steps; i++) {
            id = uuid();
        }

        expect(Date.now() - start).to.be.below(1000);
    });
});
