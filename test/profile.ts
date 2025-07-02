/*!
 * profile() Function Unit Tests
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
import * as sinon from 'sinon';
import { profile, ILogger, IMQ_LOG_LEVEL } from '..';
import { logger } from './mocks';

class ProfiledClass {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile()
    public decoratedMethod(...args: any[]) {
        return args;
    }
}

class ProfiledClassTimed {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
    })
    public decoratedMethod() {}
}

class ProfiledClassArgued {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: false,
        enableDebugArgs: true,
    })
    public decoratedMethod() {}
}

class ProfiledClassTimedAndArgued {
    // noinspection JSUnusedLocalSymbols
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
        enableDebugArgs: true,
    })
    public decoratedMethod() {}
}



describe('profile()', function() {
    let log: any;

    beforeEach(() => {
        log = sinon.spy(logger, IMQ_LOG_LEVEL)
    });

    afterEach(() => {
        log.restore();
    });

    it('should be a function', () => {
        expect(typeof profile).to.equal('function');
    });

    it('should be decorator factory', () => {
        expect(typeof profile()).to.equal('function');
    });

    it('should pass decorated method args with no change', () => {
        expect(new ProfiledClass().decoratedMethod(1, 2, 3))
            .to.deep.equal([1, 2, 3]);
    });

    it('should log time if enabled', () => {
        new ProfiledClassTimed().decoratedMethod();
        expect(log.calledOnce).to.be.true;
    });

    it('should log args if enabled', () => {
        new ProfiledClassArgued().decoratedMethod();
        expect(log.calledOnce).to.be.true;
    });

    it('should log time and args if both enabled', () => {
        new ProfiledClassTimedAndArgued().decoratedMethod();
        expect(log.calledTwice).to.be.true;
    });
});
