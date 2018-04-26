/*!
 * promisify() Function Unit Tests
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
import * as sinon from 'sinon';
import { promisify } from '..';

class FirstTestClass {
    public one(callback?: Function) {
        setTimeout(() => callback && callback());
    }
}

class SecondTestClass {
    public one(callback?: Function) {
        setTimeout(() => callback && callback());
    }
    public two(callback?: Function) {
        setTimeout(() => callback && callback());
    }
    public three(callback?: Function) {
        setTimeout(() => callback && callback());
    }
}

class ThirdTestClass {
    // noinspection JSMethodCanBeStatic
    public one(callback?: Function) {
        callback && callback();
    }
}

class TestError extends Error {}
class FourthTestClass {
    public one(callback?: Function) {
        setTimeout(() => callback && callback(new TestError()));
    }
}

describe('promisify()', function() {

    it('should convert callback-based method to promise-like', async () => {
        promisify(FirstTestClass.prototype);
        const o = new FirstTestClass();
        expect(o.one()).to.be.instanceof(Promise);
    });

    it('should restrict conversion to a given list of methods only', async () => {
        promisify(SecondTestClass.prototype, ['one', 'three']);
        const o = new SecondTestClass();
        expect(o.one()).to.be.instanceof(Promise);
        expect(o.two()).to.be.undefined;
        expect(o.three()).to.be.instanceof(Promise);
    });

    it('should act as callback-based if callback bypassed', () => {
        promisify(ThirdTestClass.prototype);
        const o = new ThirdTestClass();
        const spy = sinon.spy(()=>{});
        expect(o.one(spy)).to.be.undefined;
        expect(spy.called).to.be.true;
    });

    it('should throw when promise-like', async () => {
        promisify(FourthTestClass.prototype);
        const o = new FourthTestClass();
        try { await o.one() }
        catch (err) { expect(err).to.be.instanceof(TestError) }
    });
});
