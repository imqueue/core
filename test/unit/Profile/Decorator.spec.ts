/*!
 * profile decorator branch coverage & async rejection path unit tests
 */
import '../../mocks';
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { profile, LogLevel } from '../../..';

// Note: We intentionally call decorated methods without a "this" context
// to exercise the (this || target) branches inside the decorator wrapper.

describe('profile decorator extra branches', () => {
    it('should return early via original.apply(target, ...) when both debug flags are false and this is undefined', () => {
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

    it('should execute debug path with (this || target) picking target and logLevel fallback to IMQ_LOG_LEVEL', () => {
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
        } catch (e) {
            // expected
        }
        // allow microtask queue
        await new Promise(res => setTimeout(res, 0));
        assert.ok(logger.info.mock.callCount() > 0);
    });
});
