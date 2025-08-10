/*!
 * Additional profile.ts branch coverage tests
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as mock from 'mock-require';

// We re-require the module inside tests to pick up env changes when needed

describe('profile.ts additional branches', () => {
    afterEach(() => {
        mock.stopAll();
        delete (process as any).env.IMQ_LOG_TIME_FORMAT;
    });

    it('logDebugInfo: should not attempt to call missing log method (no-op path)', () => {
        const { logDebugInfo, LogLevel } = mock.reRequire('../src/profile');
        const fakeLogger: any = {
            // intentionally no 'log' or 'info' method for selected level
            error: sinon.spy(),
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
        expect(() => logDebugInfo(options)).to.not.throw();
        // ensures error not called due to serialization success
        expect(fakeLogger.error.called).to.equal(false);
    });

    it('logDebugInfo: should call logger.error on JSON.stringify error (BigInt arg)', () => {
        const { logDebugInfo, LogLevel } = mock.reRequire('../src/profile');
        const fakeLogger: any = {
            error: sinon.spy(),
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
        expect(fakeLogger.error.calledOnce).to.equal(true);
    });
});
