/*!
 * Decorator: @profile
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
import 'reflect-metadata';
import { ILogger } from '.';

export const IMQ_LOG_TIME = !!process.env['IMQ_LOG_TIME'];
export const IMQ_LOG_ARGS = !!process.env['IMQ_LOG_ARGS'];

/**
 * Prints debug information
 *
 * @param {boolean} debugTime
 * @param {boolean} debugArgs
 * @param {string} className
 * @param {any[]} args
 * @param {string | symbol} methodName
 * @param {number} start
 * @param {ILogger} logger
 */
export function printDebugInfo(
    debugTime: boolean,
    debugArgs: boolean,
    className: string,
    args: any[],
    methodName: string | symbol,
    start: number,
    /* istanbul ignore next */
    logger: ILogger = console
) {
    if (debugTime) {
        const end = Date.now();
        logger.log(
            `${className}.${methodName}() executed in ${end - start} ms`
        );
    }

    if (debugArgs) {
        logger.log(
            `${className}.${methodName}() called with args: ${
                JSON.stringify(args, null, 2)}`
        );
    }
}

/**
 * Implements '@profile' decorator.
 *
 * @example
 * ~~~typescript
 * import { profile } from 'imq';
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
 *  methodName: (string|symbol),
 *  descriptor: TypedPropertyDescriptor<Function>
 * ) => void}
 */
export function profile(
    enableDebugTime?: boolean,
    enableDebugArgs?: boolean
) {
    let debugTime = IMQ_LOG_TIME;
    let debugArgs = IMQ_LOG_ARGS;

    if (typeof enableDebugTime === 'boolean') {
        debugTime = enableDebugTime;
    }

    if (typeof enableDebugArgs === 'boolean') {
        debugArgs = enableDebugArgs;
    }

    return function(
        target: any,
        methodName: string | symbol,
        descriptor: TypedPropertyDescriptor<Function>
    ) {
        /* istanbul ignore next */
        const original = descriptor.value || target[methodName];

        descriptor.value = function(...args: any[]) {
            if (!(debugTime || debugArgs)) {
                return original.apply(this, args);
            }

            const start = Date.now();
            const result = original.apply(this, args);
            /* istanbul ignore next */
            const className = typeof target === 'function' && target.name
                ? target.name              // static
                : target.constructor.name; // dynamic

            /* istanbul ignore next */
            if (result && typeof result.then === 'function') {
                // async call detected
                result.then((res: any) => {
                    printDebugInfo(
                        debugTime,
                        debugArgs,
                        className,
                        args,
                        methodName,
                        start,
                        this.logger
                    );

                    return res;
                });
                return result;
            }

            printDebugInfo(
                debugTime,
                debugArgs,
                className,
                args,
                methodName,
                start,
                this.logger
            );

            return result;
        };
    }
}
