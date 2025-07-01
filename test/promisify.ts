/*!
 * promisify() Function Unit Tests
 *
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
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import { promisify } from '..';

class FirstTestClass {
    public one(callback?: (...args: any[]) => void) {
        setTimeout(() => callback && callback());
    }
}

class SecondTestClass {
    public one(callback?: (...args: any[]) => void) {
        setTimeout(() => callback && callback());
    }
    public two(callback?: (...args: any[]) => void) {
        setTimeout(() => callback && callback());
    }
    public three(callback?: (...args: any[]) => void) {
        setTimeout(() => callback && callback());
    }
}

class ThirdTestClass {
    // noinspection JSMethodCanBeStatic
    public one(callback?: (...args: any[]) => void) {
        callback && callback();
    }
}

class TestError extends Error {}
class FourthTestClass {
    public one(callback?: (...args: any[]) => void) {
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
        const spy = sinon.spy(() => {});
        expect(o.one(spy)).to.be.undefined;
        expect(spy.called).to.be.true;
    });

    it('should throw when promise-like', async () => {
        promisify(FourthTestClass.prototype);
        const o = new FourthTestClass();
        try {
            await o.one();
        } catch (err) {
            expect(err).to.be.instanceof(TestError);
        }
    });
});
