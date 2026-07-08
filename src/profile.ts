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
import { ILogger } from '.';

export enum LogLevel {
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
     * Defines log/level for logger,
     * By default, is a log
     */
    logLevel?: LogLevel;
}

/**
 * Validates a log level value or returns the default
 *
 * @param {unknown} level - the level to validate
 * @returns {LogLevel} - validated log level or INFO if invalid
 */
export function verifyLogLevel(level: unknown): LogLevel {
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
 * Environment variable IMQ_LOG_TIME=[1, 0]. Enable or disable profiled
 * timing logging.
 *
 * @type {boolean}
 */
export const IMQ_LOG_TIME: boolean = !!+(process.env.IMQ_LOG_TIME || 0);

/**
 * Environment variable IMQ_LOG_ARGS=[1, 0]. Enable or disable logging of
 * profiled call arguments.
 *
 * @type {boolean}
 */
export const IMQ_LOG_ARGS: boolean = !!+(process.env.IMQ_LOG_ARGS || 0);

/**
 * Environment variable IMQ_LOG_TIME_FORMAT. Specifies the format for profiled
 * time logging. Values: 'microseconds', 'milliseconds', 'seconds'.
 * Default: 'microseconds'
 *
 * @type {AllowedTimeFormat | string}
 */
export const IMQ_LOG_TIME_FORMAT: AllowedTimeFormat =
    (process.env.IMQ_LOG_TIME_FORMAT as AllowedTimeFormat) || 'microseconds';

export interface DebugInfoOptions {
    /**
     * Enable or disable execution time debugging
     */
    debugTime: boolean;
    /**
     * Enable or disable call arguments debugging
     */
    debugArgs: boolean;
    /**
     * Class name
     */
    className: string;
    /**
     * Call arguments
     */
    args: unknown[];
    /**
     * Method name
     */
    methodName: string;
    /**
     * Execution start timestamp (from process.hrtime.bigint or milliseconds)
     */
    start: bigint | number;
    /**
     * Logger implementation (absent when the target carries no logger)
     */
    logger?: ILogger;
    /**
     * Log level to use for the call
     */
    logLevel: LogLevel;
}

/**
 * Logs debug information about a function call
 *
 * @param {DebugInfoOptions} options - debug information options
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
    const log =
        logger && typeof logger[logLevel] === 'function'
            ? logger[logLevel].bind(logger)
            : undefined;

    if (debugTime) {
        const time = Number(process.hrtime.bigint() - BigInt(start)) / 1000;
        let timeStr: string;

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
        const cache: unknown[] = [];

        try {
            argStr = JSON.stringify(
                args,
                (_key: string, value: unknown) => {
                    if (typeof value === 'object' && value !== null) {
                        if (~cache.indexOf(value)) {
                            try {
                                return JSON.parse(JSON.stringify(value));
                            } catch {
                                return;
                            }
                        }

                        cache.push(value);
                    }

                    return value;
                },
                2,
            );
        } catch (err) {
            logger?.error(err);
        }

        if (log) {
            log(`${className}.${methodName}() called with args: ${argStr}`);
        }
    }
}

/**
 * Resolves the class name of a decorated call target — the class itself for
 * a static call, or the instance's constructor for an instance call.
 *
 * @param {unknown} target
 * @returns {string}
 */
function resolveClassName(target: unknown): string {
    if (typeof target === 'function') {
        return target.name;
    }

    if (typeof target === 'object' && target !== null) {
        return (
            (target as { constructor?: { name?: string } }).constructor?.name ??
            ''
        );
    }

    return '';
}

/**
 * Extracts the logger instance from a decorated target, if present.
 *
 * @param {unknown} target - the decorated target object
 * @returns {ILogger | undefined} - the logger instance or undefined
 */
function resolveLogger(target: unknown): ILogger | undefined {
    if (typeof target === 'object' && target !== null) {
        return (target as { logger?: ILogger }).logger;
    }

    return undefined;
}

/**
 * Type guard detecting a thenable (promise-like) value. Generic so that
 * narrowing preserves the input type (T & PromiseLike) rather than widening
 * to PromiseLike<unknown> — this keeps the guard usable on a generic return
 * value under stricter/older compiler configurations used by consumers.
 *
 * @param {T} value
 * @returns {value is T & PromiseLike<unknown>}
 */
function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        typeof (value as { then?: unknown }).then === 'function'
    );
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
 *     @profile() // profiling happens only depending on env DEBUG flag
 *     private innerMethod() {
 *         // ...
 *     }
 * }
 * ~~~
 *
 * @returns {(
 *     target: any,
 *     methodName: (string),
 *     descriptor: TypedPropertyDescriptor<(...args: any[]) => any>,
 * ) => void}
 */
export function profile(options?: ProfileDecoratorOptions): any {
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

    const wrap = (original: (...args: any[]) => any, methodName: string) =>
        function wrapper(this: any, ...args: any[]): any {
            if (!(debugTime || debugArgs)) {
                return original.apply(this, args);
            }

            const className = resolveClassName(this);
            const logger = resolveLogger(this);
            const start = process.hrtime.bigint();
            const result = original.apply(this, args);
            const debugOptions: DebugInfoOptions = {
                args,
                className,
                debugArgs,
                debugTime,
                logLevel: logLevel ? verifyLogLevel(logLevel) : IMQ_LOG_LEVEL,
                logger,
                methodName,
                start,
            };

            if (isThenable(result)) {
                // async call detected — log once it settles either way
                const logAfter = (): void => logDebugInfo(debugOptions);

                result.then(logAfter, logAfter);

                return result;
            }

            logDebugInfo(debugOptions);

            return result;
        };

    // Dual-mode: standard (TC39) invocations pass a context object with a
    // `kind` property; legacy ones pass (target, propertyKey, descriptor).
    return function (target: any, context: any, descriptor?: any): any {
        if (context && typeof context === 'object' && 'kind' in context) {
            return wrap(target, String(context.name));
        }

        descriptor.value = wrap(descriptor.value, String(context));

        return descriptor;
    };
}
