/*!
 * profile() Function & Decorator Unit Tests (merged: profile() behavior,
 * logDebugInfo branches, decorator extra branches, and async rejection path)
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
import '../mocks/index.js';
import {
    describe,
    it,
    beforeEach,
    afterEach,
    mock,
    type Mock,
} from 'node:test';
import assert from 'node:assert/strict';
import {
    profile,
    type ILogger,
    verifyLogLevel,
    LogLevel,
    type DebugInfoOptions,
} from '../../index.js';
import { logger } from '../mocks/index.js';

let reloadCounter = 0;

/**
 * Loads a fresh, uncached copy of a module so that its module-scope state
 * (e.g. env-derived constants) is re-evaluated. The ES module registry is
 * immutable, so freshness is achieved with a unique query string per load.
 *
 * @param {string} id - module id, relative to this file, without extension
 * @returns {Promise<any>} - the freshly loaded module namespace
 */
function reRequire(id: string): Promise<any> {
    const href = new URL(`${id}.js`, import.meta.url).href;

    return import(`${href}?reload=${++reloadCounter}`);
}

const BIG_INT_SUPPORT = (() => {
    try {
        return !!BigInt(0);
    } catch {
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

    beforeEach(() => {
        log = mock.method(logger, 'log');
        error = mock.method(logger, 'error');
        // spied to suppress profiler output during tests (not asserted on)
        mock.method(logger, 'warn');
        mock.method(logger, 'info');
    });

    afterEach(() => {
        mock.restoreAll();
        delete process.env.IMQ_LOG_TIME_FORMAT;
    });

    it('should be a function', async () => {
        assert.equal(typeof profile, 'function');
    });

    it('should be decorator factory', async () => {
        assert.equal(typeof profile(), 'function');
    });

    it('should pass decorated method args with no change', async () => {
        assert.deepEqual(
            new ProfiledClass().decoratedMethod(1, 2, 3),
            [1, 2, 3],
        );
    });

    it('should log time if enabled', async () => {
        new ProfiledClassTimed().decoratedMethod();
        assert.equal(log.mock.callCount(), 1);
    });

    it('should log args if enabled', async () => {
        new ProfiledClassArgued().decoratedMethod();
        assert.equal(log.mock.callCount(), 1);
    });

    it('should log time and args if both enabled', async () => {
        new ProfiledClassTimedAndArgued().decoratedMethod();
        assert.equal(log.mock.callCount(), 2);
    });

    it('should handle async methods correctly', async () => {
        await new ProfiledClass().decoratedAsyncMethod();
        assert.equal(log.mock.callCount(), 2);
    });

    describe('verifyLogLevel()', () => {
        it('should return valid log levels as is', async () => {
            assert.equal(verifyLogLevel(LogLevel.LOG), LogLevel.LOG);
            assert.equal(verifyLogLevel(LogLevel.INFO), LogLevel.INFO);
            assert.equal(verifyLogLevel(LogLevel.WARN), LogLevel.WARN);
            assert.equal(verifyLogLevel(LogLevel.ERROR), LogLevel.ERROR);
        });

        it('should return default log level on invalid value', async () => {
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

        it('should log time in microseconds by default', async () => {
            const { logDebugInfo } = await reRequire('../../src/profile');
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /μs/), true);
        });

        it('should log time in milliseconds', async () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'milliseconds';
            const { logDebugInfo } = await reRequire('../../src/profile');
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /ms/), true);
        });

        it('should log time in seconds', async () => {
            process.env.IMQ_LOG_TIME_FORMAT = 'seconds';
            const { logDebugInfo } = await reRequire('../../src/profile');
            logDebugInfo(baseOptions);
            assert.equal(calledWithMatch(log, /sec/), true);
        });

        it('should handle circular references in args', async () => {
            const { logDebugInfo } = await reRequire('../../src/profile');
            const a: any = { b: 1 };
            const b = { a };
            a.b = b;
            logDebugInfo({ ...baseOptions, args: [a] });
            assert.equal(error.mock.callCount(), 0);
        });

        it('should not log when logger method is missing', async () => {
            const { logDebugInfo } = await reRequire('../../src/profile');
            const dummyLogger: any = { error: logger.error.bind(logger) };
            logDebugInfo({
                ...baseOptions,
                logger: dummyLogger,
                logLevel: 'nonexistent' as any,
            });
            assert.equal(log.mock.callCount(), 0);
        });

        it('should handle JSON.stringify errors', async () => {
            const { logDebugInfo } = await reRequire('../../src/profile');
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
        delete (process as any).env.IMQ_LOG_TIME_FORMAT;
    });

    it('logDebugInfo: should not attempt to call missing log method (no-op path)', async () => {
        const { logDebugInfo, LogLevel } = await reRequire('../../src/profile');
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

    it('logDebugInfo: should call logger.error on JSON.stringify error (BigInt arg)', async () => {
        const { logDebugInfo, LogLevel } = await reRequire('../../src/profile');
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

describe('profile decorator extra branches', () => {
    it('should return early via original.apply(target, ...) when both debug flags are false and this is undefined', async () => {
        class T1 {
            @profile({
                enableDebugTime: false,
                enableDebugArgs: false,
                logLevel: LogLevel.LOG,
            })
            public m(...args: any[]) {
                return args;
            }
        }
        const o = new T1();
        const fn = Object.getPrototypeOf(o).m as Function; // wrapper
        const res = fn.call(undefined, 1, 2, 3);
        assert.deepEqual(res, [1, 2, 3]);
    });

    it('should execute debug path with (this || target) picking target and logLevel fallback to IMQ_LOG_LEVEL', async () => {
        class T2 {
            // no logger on prototype; calling with undefined this picks target
            @profile({
                enableDebugTime: true,
                enableDebugArgs: true,
                logLevel: undefined as any,
            })
            public m(..._args: any[]) {
                /* noop */
            }
        }
        const o = new T2();
        const fn = Object.getPrototypeOf(o).m as Function; // wrapper
        // provide serializable args to avoid logger.error path when logger is undefined
        assert.doesNotThrow(() => fn.call(undefined, 1, { a: 2 }, 'x'));
    });
});

class RejectingClass {
    public logger: any = { info: () => undefined, error: () => undefined };

    @profile({ enableDebugTime: true, enableDebugArgs: true })
    public async willReject(): Promise<any> {
        return Promise.reject(new Error('boom'));
    }
}

describe('profile() async rejection path', () => {
    it('should log via logger when async method rejects', async () => {
        const logger = { info: mock.fn(), error: () => undefined } as any;
        const obj = new RejectingClass();
        obj.logger = logger;
        try {
            await obj.willReject();
        } catch {
            // expected
        }
        // allow microtask queue
        await new Promise(res => setTimeout(res, 0));
        assert.ok(logger.info.mock.callCount() > 0);
    });
});

describe('profile() legacy decorator signature', () => {
    it('wraps via the legacy (target, key, descriptor) form', async () => {
        const decorator = profile({ enableDebugTime: true });
        const original = function (): number {
            return 42;
        };
        const descriptor: any = { value: original };

        const result = decorator({}, 'legacyMethod', descriptor);

        assert.equal(result, descriptor);
        assert.notEqual(descriptor.value, original);
        assert.equal(descriptor.value(), 42);
    });

    it('resolves the class name from a function target', async () => {
        const decorator = profile({ enableDebugTime: true });
        const descriptor: any = {
            value: function (): number {
                return 7;
            },
        };

        decorator({}, 'staticMethod', descriptor);

        // invoking with `this` bound to a class (a function) exercises the
        // function-target branch of class-name resolution
        class StaticHolder {}

        assert.equal(descriptor.value.call(StaticHolder), 7);
    });
});
