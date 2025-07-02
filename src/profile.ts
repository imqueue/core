/*!
 * Decorator: @profile
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
import 'reflect-metadata';
import { ILogger } from '.';

export enum LogLevel {
    // noinspection JSUnusedGlobalSymbols
    LOG = 'log',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

export interface ProfileDecoratorOptions {
    /**
     * Turns on/off execution time debugging
     */
    enableDebugTime?: boolean;
    /**
     * Turns on/off arguments debugging
     */
    enableDebugArgs?: boolean;
    /**
     * Defines log/level for logger
     * By default is log
     */
    logLevel?: LogLevel;
}

/**
 * Checks if log level is set to proper value or returns default one
 *
 * @param {*} level
 * @return {LogLevel}
 */
export function verifyLogLevel(level: any): LogLevel {
    switch (level) {
        case LogLevel.LOG:
        case LogLevel.INFO:
        case LogLevel.WARN:
        case LogLevel.ERROR:
            return level;
        default:
            return LogLevel.INFO;
    }
}

export const IMQ_LOG_LEVEL = verifyLogLevel(process.env.IMQ_LOG_LEVEL);

const DEFAULT_OPTIONS: ProfileDecoratorOptions = {
    logLevel: IMQ_LOG_LEVEL,
};

export type AllowedTimeFormat = 'microseconds' | 'milliseconds' | 'seconds';

/**
 * Environment variable IMQ_LOG_TIME=[1, 0] - enables/disables profiled
 * timings logging
 *
 * @type {boolean}
 */
export const IMQ_LOG_TIME = !!+(process.env.IMQ_LOG_TIME || 0);

/**
 * Environment variable IMQ_LOG_ARGS=[1, 0] - enables/disables profiled
 * call arguments to be logged
 *
 * @type {boolean}
 */
export const IMQ_LOG_ARGS = !!+(process.env.IMQ_LOG_ARGS || 0);

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
    process.env.IMQ_LOG_TIME_FORMAT as AllowedTimeFormat || 'microseconds';

export interface DebugInfoOptions {
    /**
     * Turns on/off time debugging
     */
    debugTime: boolean;
    /**
     * Turns on/off args debugging
     */
    debugArgs: boolean;
    /**
     * Class name
     */
    className: string;
    /**
     * Call arguments
     */
    args: any[];
    /**
     * Method name
     */
    methodName: string;
    /**
     * Execution start timestamp
     */
    start: any;
    /**
     * Logger implementation
     */
    logger: ILogger;
    /**
     * Log level to use for the call
     */
    logLevel: LogLevel;
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
 * @param {LogLevel} logLevel
 */
export function logDebugInfo({
    debugTime,
    debugArgs,
    className,
    args,
    methodName,
    start,
    logger,
    logLevel,
}: DebugInfoOptions) {
    const log = logger && typeof logger[logLevel] === 'function'
        ? logger[logLevel].bind(logger) : undefined;

    if (debugTime) {
        // noinspection TypeScriptUnresolvedFunction
        const time = parseInt(
            ((process.hrtime as any).bigint() - start) as any,
            10,
        ) / 1000;
        let timeStr: string;

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

        if (log) {
            log(`${className}.${methodName}() executed in ${timeStr}`);
        }
    }

    if (debugArgs) {
        let argStr: string = '';
        const cache: any[] = [];

        try {
            argStr = JSON.stringify(args, (key: string, value: any) => {
                if (typeof value === 'object' && value !== null) {
                    if (~cache.indexOf(value)) {
                        try {
                            return JSON.parse(JSON.stringify(value));
                        } catch (error) {
                            return;
                        }
                    }

                    cache.push(value);
                }

                return value;
            }, 2);
        } catch (err) {
            logger.error(err);
        }

        if (log) {
            log(`${className}.${methodName}() called with args: ${argStr}`);
        }
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
export function profile(options?: ProfileDecoratorOptions): (
    target: any,
    methodName: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
) => void {
    options = Object.assign({}, DEFAULT_OPTIONS, options);

    const { enableDebugTime, enableDebugArgs, logLevel } = options;
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
                return original.apply(this || target, args);
            }

            /* istanbul ignore next */
            const className = typeof target === 'function' && target.name
                ? target.name              // static
                : target.constructor.name; // dynamic
            // noinspection TypeScriptUnresolvedFunction
            const start = (process.hrtime as any).bigint();
            const result = original.apply(this || target, args);
            const debugOptions: DebugInfoOptions = {
                args,
                className,
                debugArgs,
                debugTime,
                logLevel: logLevel ? verifyLogLevel(logLevel) : IMQ_LOG_LEVEL,
                logger: (this || target).logger,
                methodName,
                start,
            };

            /* istanbul ignore next */
            if (result && typeof result.then === 'function') {
                // async call detected
                result.then((res: any) => {
                    logDebugInfo(debugOptions);

                    return res;
                }).catch(() => {
                    logDebugInfo(debugOptions);
                });

                return result;
            }

            logDebugInfo(debugOptions);

            return result;
        };
    };
}
