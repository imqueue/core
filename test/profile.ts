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
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as mock from 'mock-require';
import {
    profile,
    ILogger,
    verifyLogLevel,
    LogLevel,
    DebugInfoOptions,
} from '..';
import { logger } from './mocks';

const BIG_INT_SUPPORT = (() => {
    try {
        return !!BigInt(0);
    } catch (err) {
        return false;
    }
})();

class ProfiledClass {
    private logger: ILogger = logger;

    @profile()
    public decoratedMethod(...args: any[]) {
        return args;
    }

    @profile({
        enableDebugTime: true,
        enableDebugArgs: true,
        logLevel: LogLevel.LOG,
    })
    public async decoratedAsyncMethod() {
        return new Promise(resolve => setTimeout(resolve, 10));
    }
}

class ProfiledClassTimed {
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
        logLevel: LogLevel.LOG,
    })
    public decoratedMethod() {}
}

class ProfiledClassArgued {
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: false,
        enableDebugArgs: true,
        logLevel: LogLevel.LOG,
    })
    public decoratedMethod() {}
}

class ProfiledClassTimedAndArgued {
    private logger: ILogger = logger;

    @profile({
        enableDebugTime: true,
        enableDebugArgs: true,
        logLevel: LogLevel.LOG,
    })
    public decoratedMethod() {}
}

describe('profile()', function() {
    let log: any;
    let error: any;
    let warn: any;
    let info: any;

    beforeEach(() => {
        log = sinon.spy(logger, 'log');
        error = sinon.spy(logger, 'error');
        warn = sinon.spy(logger, 'warn');
        info = sinon.spy(logger, 'info');
    });

    afterEach(() => {
        log.restore();
        error.restore();
        warn.restore();
        info.restore();
        mock.stopAll();
        delete process.env.IMQ_LOG_TIME_FORMAT;
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

    it('should handle async methods correctly', async () => {
        await new ProfiledClass().decoratedAsyncMethod();
        expect(log.calledTwice).to.be.true;
    });

    describe('verifyLogLevel()', () => {
        it('should return valid log levels as is', () => {
            expect(verifyLogLevel(LogLevel.LOG)).to.equal(LogLevel.LOG);
            expect(verifyLogLevel(LogLevel.INFO)).to.equal(LogLevel.INFO);
            expect(verifyLogLevel(LogLevel.WARN)).to.equal(LogLevel.WARN);
            expect(verifyLogLevel(LogLevel.ERROR)).to.equal(LogLevel.ERROR);
        });

        it('should return default log level on invalid value', () => {
            expect(verifyLogLevel('invalid')).to.equal(LogLevel.INFO);
        });
    });

    describe('logDebugInfo()', () => {
        const start = BIG_INT_SUPPORT ? BigInt(1) : 1;
        const baseOptions: DebugInfoOptions = {
            debugTime: true,
            debugArgs: true,
            className: 'TestClass',
            args: [1, 'a', { b: 2 }],
            methodName: 'testMethod',
            start,
            logger,
            logLevel: LogLevel.LOG,
        };

        it('should log time in microseconds by default', () => {
            const { logDebugInfo } = mock.reRequire('../src/profile');
            logDebugInfo(baseOptions);
            expect(log.calledWithMatch(/μs/)).to.be.true;
        });

        it('should log time in milliseconds', () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'milliseconds';
            const { logDebugInfo } = mock.reRequire('../src/profile');
            logDebugInfo(baseOptions);
            expect(log.calledWithMatch(/ms/)).to.be.true;
        });

        it('should log time in seconds', () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'seconds';
            const { logDebugInfo } = mock.reRequire('../src/profile');
            logDebugInfo(baseOptions);
            expect(log.calledWithMatch(/sec/)).to.be.true;
        });

        it('should handle circular references in args', () => {
            const { logDebugInfo } = mock.reRequire('../src/profile');
            const a: any = { b: 1 };
            const b = { a };
            a.b = b;
            logDebugInfo({ ...baseOptions, args: [a] });
            expect(error.notCalled).to.be.true;
        });

        it('should not log when logger method is missing', () => {
            const { logDebugInfo } = mock.reRequire('../src/profile');
            const dummyLogger: any = { error: logger.error.bind(logger) };
            logDebugInfo({ ...baseOptions, logger: dummyLogger, logLevel: 'nonexistent' as any });
            expect(log.notCalled).to.be.true;
        });

        it('should handle JSON.stringify errors', () => {
            const { logDebugInfo } = mock.reRequire('../src/profile');
            const badJson = { toJSON: () => { throw new Error('bad json'); } };
            logDebugInfo({ ...baseOptions, args: [badJson] });
            expect(error.calledOnce).to.be.true;
        });
    });
});