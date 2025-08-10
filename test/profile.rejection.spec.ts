/*!
 * Additional profile tests for async rejection catch path
 */
import './mocks';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { profile } from '..';
import * as core from '..';

class RejectingClass {
    public logger: any = { info: () => undefined, error: () => undefined };

    @profile({ enableDebugTime: true, enableDebugArgs: true })
    public async willReject(): Promise<any> {
        return Promise.reject(new Error('boom'));
    }
}

describe('profile() async rejection path', () => {
    it('should log via logger when async method rejects', async () => {
        const logger = { info: sinon.spy(), error: () => undefined } as any;
        const obj = new RejectingClass();
        obj.logger = logger;
        try {
            await obj.willReject();
        } catch (e) {
            // expected
        }
        // allow microtask queue
        await new Promise(res => setTimeout(res, 0));
        expect(logger.info.called).to.be.true;
    });
});
