/*!
 * Decorator: @profile
 *
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
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
import * as mt from 'microtime';
import 'reflect-metadata';
import { ILogger } from '.';

export type AllowedTimeFormat = 'microseconds' | 'milliseconds' | 'seconds';

/**
 * Environment variable IMQ_LOG_TIME=[1, 0] - enables/disables profiled
 * timings logging
 *
 * @type {boolean}
 */
export const IMQ_LOG_TIME = !!process.env['IMQ_LOG_TIME'];

/**
 * Environment variable IMQ_LOG_ARGS=[1, 0] - enables/disables profiled
 * call arguments to be logged
 *
 * @type {boolean}
 */
export const IMQ_LOG_ARGS = !!process.env['IMQ_LOG_ARGS'];

/**
 * Environment variable IMQ_LOG_TIME_FORMAT=[
 *   'microseconds',
 *   'milliseconds',
 *   'seconds'
 * ]. Specifies profiled time logging format, by default is 'microseconds'
 *
 * @type {AllowedTimeFormat | string}
 */
export const IMQ_LOG_TIME_FORMAT: AllowedTimeFormat =
    process.env['IMQ_LOG_TIME_FORMAT'] as AllowedTimeFormat || 'microseconds';

export interface DebugInfoOptions {
    debugTime: boolean;
    debugArgs: boolean;
    className: string;
    args: any[];
    methodName: string;
    start: number;
    logger: ILogger;
}

/**
 * Prints debug information
 *
 * @param {boolean} debugTime
 * @param {boolean} debugArgs
 * @param {string} className
 * @param {any[]} args
 * @param {string} methodName
 * @param {number} start
 * @param {ILogger} logger
 */
export function logDebugInfo({
    debugTime,
    debugArgs,
    className,
    args,
    methodName,
    start,
    logger,
}: DebugInfoOptions) {
    if (debugTime) {
        const time = mt.now() - start;
        let timeStr = '';

        // istanbul ignore next
        switch (IMQ_LOG_TIME_FORMAT) {
            case 'milliseconds':
                timeStr = (time / 1000).toFixed(3) + ' ms';
                break;
            case 'seconds':
                timeStr = (time / 1000000).toFixed(3) + ' sec';
                break;
            default:
                timeStr = time + ' μs';
                break;
        }

        logger.log(`${className}.${methodName}() executed in ${timeStr}`);
    }

    if (debugArgs) {
        logger.log(
            `${className}.${methodName}() called with args: ${
                JSON.stringify(args, undefined, 2)}`,
        );
    }
}

/**
 * Implements '@profile' decorator.
 *
 * @example
 * ~~~typescript
 * import { profile } from '@imqueue/core';
 *
 * class MyClass {
 *
 *     @profile(true) // forced profiling
 *     public myMethod() {
 *         // ...
 *     }
 *
 *     @profile() // profiling happened only depending on env DEBUG flag
 *     private innerMethod() {
 *         // ...
 *     }
 * }
 * ~~~
 *
 * @return {(
 *  target: any,
 *  methodName: (string),
 *  descriptor: TypedPropertyDescriptor<(...args: any[]) => any>
 * ) => void}
 */
export function profile(
    enableDebugTime?: boolean,
    enableDebugArgs?: boolean,
) {
    let debugTime = IMQ_LOG_TIME;
    let debugArgs = IMQ_LOG_ARGS;

    if (typeof enableDebugTime === 'boolean') {
        debugTime = enableDebugTime;
    }

    if (typeof enableDebugArgs === 'boolean') {
        debugArgs = enableDebugArgs;
    }

    return function wrapper(
        target: any,
        methodName: string,
        descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
    ) {
        /* istanbul ignore next */
        const original = descriptor.value || target[methodName];

        descriptor.value = function(...args: any[]) {
            if (!(debugTime || debugArgs)) {
                return original.apply(this, args);
            }

            /* istanbul ignore next */
            const className = typeof target === 'function' && target.name
                ? target.name              // static
                : target.constructor.name; // dynamic
            const start = mt.now();
            const result = original.apply(this, args);
            const debugOptions: DebugInfoOptions = {
                args,
                className,
                debugArgs,
                debugTime,
                logger: this.logger,
                methodName,
                start,
            };

            /* istanbul ignore next */
            if (result && typeof result.then === 'function') {
                // async call detected
                result.then((res: any) => {
                    logDebugInfo(debugOptions);

                    return res;
                });

                return result;
            }

            logDebugInfo(debugOptions);

            return result;
        };
    };
}
