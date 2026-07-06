/*!
 * profile() Function Unit Tests (merged with additional branch coverage)
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
import '../../mocks';
import { describe, it, beforeEach, afterEach, mock, Mock } from 'node:test';
import * as assert from 'node:assert/strict';
import mockRequire from 'mock-require';
import {
    profile,
    ILogger,
    verifyLogLevel,
    LogLevel,
    DebugInfoOptions,
} from '../../..';
import { logger } from '../../mocks';

const BIG_INT_SUPPORT = (() => {
    try {
        return !!BigInt(0);
    } catch (err) {
        return false;
    }
})();

function calledWithMatch(spy: Mock<any>, re: RegExp): boolean {
    return spy.mock.calls.some((call: any) =>
        call.arguments.some((arg: any) => re.test(String(arg))),
    );
}

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

describe('profile()', () => {
    let log: Mock<any>;
    let error: Mock<any>;
    let warn: Mock<any>;
    let info: Mock<any>;

    beforeEach(() => {
        log = mock.method(logger, 'log');
        error = mock.method(logger, 'error');
        warn = mock.method(logger, 'warn');
        info = mock.method(logger, 'info');
    });

    afterEach(() => {
        mock.restoreAll();
        mockRequire.stopAll();
        delete process.env.IMQ_LOG_TIME_FORMAT;
    });

    it('should be a function', () => {
        assert.equal(typeof profile, 'function');
    });

    it('should be decorator factory', () => {
        assert.equal(typeof profile(), 'function');
    });

    it('should pass decorated method args with no change', () => {
        assert.deepEqual(
            new ProfiledClass().decoratedMethod(1, 2, 3),
            [1, 2, 3],
        );
    });

    it('should log time if enabled', () => {
        new ProfiledClassTimed().decoratedMethod();
        assert.equal(log.mock.callCount(), 1);
    });

    it('should log args if enabled', () => {
        new ProfiledClassArgued().decoratedMethod();
        assert.equal(log.mock.callCount(), 1);
    });

    it('should log time and args if both enabled', () => {
        new ProfiledClassTimedAndArgued().decoratedMethod();
        assert.equal(log.mock.callCount(), 2);
    });

    it('should handle async methods correctly', async () => {
        await new ProfiledClass().decoratedAsyncMethod();
        assert.equal(log.mock.callCount(), 2);
    });

    describe('verifyLogLevel()', () => {
        it('should return valid log levels as is', () => {
            assert.equal(verifyLogLevel(LogLevel.LOG), LogLevel.LOG);
            assert.equal(verifyLogLevel(LogLevel.INFO), LogLevel.INFO);
            assert.equal(verifyLogLevel(LogLevel.WARN), LogLevel.WARN);
            assert.equal(verifyLogLevel(LogLevel.ERROR), LogLevel.ERROR);
        });

        it('should return default log level on invalid value', () => {
            assert.equal(verifyLogLevel('invalid'), LogLevel.INFO);
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
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /μs/), true);
        });

        it('should log time in milliseconds', () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'milliseconds';
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /ms/), true);
        });

        it('should log time in seconds', () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'seconds';
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /sec/), true);
        });

        it('should handle circular references in args', () => {
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            const a: any = { b: 1 };
            const b = { a };
            a.b = b;
            logDebugInfo({ ...baseOptions, args: [a] });
            assert.equal(error.mock.callCount(), 0);
        });

        it('should not log when logger method is missing', () => {
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            const dummyLogger: any = { error: logger.error.bind(logger) };
            logDebugInfo({
                ...baseOptions,
                logger: dummyLogger,
                logLevel: 'nonexistent' as any,
            });
            assert.equal(log.mock.callCount(), 0);
        });

        it('should handle JSON.stringify errors', () => {
            const { logDebugInfo } = mockRequire.reRequire(
                '../../../src/profile',
            );
            const badJson = {
                toJSON: () => {
                    throw new Error('bad json');
                },
            };
            logDebugInfo({ ...baseOptions, args: [badJson] });
            assert.equal(error.mock.callCount(), 1);
        });
    });
});

describe('profile.ts additional branches', () => {
    afterEach(() => {
        mock.restoreAll();
        mockRequire.stopAll();
        delete (process as any).env.IMQ_LOG_TIME_FORMAT;
    });

    it('logDebugInfo: should not attempt to call missing log method (no-op path)', () => {
        const { logDebugInfo, LogLevel } = mockRequire.reRequire(
            '../../../src/profile',
        );
        const fakeLogger: any = {
            // intentionally no 'log' or 'info' method for selected level
            error: mock.fn(),
        };
        const options = {
            debugTime: true,
            debugArgs: true,
            className: 'X',
            args: [1, { a: 2 }],
            methodName: 'm',
            start: (process.hrtime as any).bigint(),
            logger: fakeLogger,
            logLevel: LogLevel.LOG,
        };
        assert.doesNotThrow(() => logDebugInfo(options));
        // ensures error not called due to serialization success
        assert.equal(fakeLogger.error.mock.callCount() > 0, false);
    });

    it('logDebugInfo: should call logger.error on JSON.stringify error (BigInt arg)', () => {
        const { logDebugInfo, LogLevel } = mockRequire.reRequire(
            '../../../src/profile',
        );
        const fakeLogger: any = {
            error: mock.fn(),
        };
        const args = [BigInt(1)]; // JSON.stringify throws on BigInt
        const options = {
            debugTime: false,
            debugArgs: true,
            className: 'Y',
            args,
            methodName: 'n',
            start: (process.hrtime as any).bigint(),
            logger: fakeLogger,
            logLevel: LogLevel.INFO,
        };
        logDebugInfo(options);
        assert.equal(fakeLogger.error.mock.callCount(), 1);
    });
});
