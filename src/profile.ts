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
import { type ILogger } from './index.js';

/**
 * Logger method to which profiling output is dispatched. Each value is the
 * literal name of the corresponding {@link ILogger} method, so the level is used
 * as a property lookup on the logger.
 */
export enum LogLevel {
    /**
     * Dispatches to {@link ILogger.log}.
     */
    LOG = 'log',
    /**
     * Dispatches to {@link ILogger.info}. This is the default level.
     */
    INFO = 'info',
    /**
     * Dispatches to {@link ILogger.warn}.
     */
    WARN = 'warn',
    /**
     * Dispatches to {@link ILogger.error}.
     */
    ERROR = 'error',
}

/**
 * Options accepted by the {@link profile} decorator.
 *
 * Every field is optional; omitted fields fall back to the {@link IMQ_LOG_TIME},
 * {@link IMQ_LOG_ARGS} and {@link IMQ_LOG_LEVEL} environment defaults.
 *
 * @remarks
 * `enableDebugTime` and `enableDebugArgs` override the environment defaults only
 * when passed as real booleans — any other value is ignored and the environment
 * default applies.
 */
export interface ProfileDecoratorOptions {
    /**
     * Turns on/off execution time debugging, overriding {@link IMQ_LOG_TIME}.
     */
    enableDebugTime?: boolean;
    /**
     * Turns on/off arguments debugging, overriding {@link IMQ_LOG_ARGS}.
     */
    enableDebugArgs?: boolean;
    /**
     * Logger method used for the profiling output — one of `log`, `info`, `warn`
     * or `error`. Overrides {@link IMQ_LOG_LEVEL}, which itself defaults to
     * `info`.
     *
     * @remarks
     * An unrecognized level resolves to `info` rather than falling back to the
     * environment value.
     */
    logLevel?: LogLevel;
}

/**
 * Normalizes an arbitrary value into a {@link LogLevel}.
 *
 * @param level - the value to validate
 * @returns `level` unchanged when it is one of `log`, `info`, `warn` or `error`;
 *          otherwise {@link LogLevel.INFO}
 *
 * @remarks
 * Never throws — `null`, `undefined` and unrelated types all resolve to
 * {@link LogLevel.INFO}, which makes this the safe way to sanitize an untrusted
 * level string.
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

/**
 * Default logger method for profiling output, from the `IMQ_LOG_LEVEL`
 * environment variable.
 *
 * Accepts `log`, `info`, `warn` or `error`; any other or missing value resolves
 * to `info` without warning.
 *
 * @remarks
 * Read once when the module is first imported, so later changes to
 * `process.env` have no effect. Individual decorators override it via
 * {@link ProfileDecoratorOptions.logLevel}.
 */
export const IMQ_LOG_LEVEL = verifyLogLevel(process.env.IMQ_LOG_LEVEL);

const DEFAULT_OPTIONS: ProfileDecoratorOptions = {
    logLevel: IMQ_LOG_LEVEL,
};

/**
 * Units in which profiled execution time can be rendered.
 *
 * @remarks
 * Used as the declared type of {@link IMQ_LOG_TIME_FORMAT}. Note that the
 * environment value is cast rather than validated, so an out-of-range string is
 * possible at runtime and behaves as `microseconds`.
 */
export type AllowedTimeFormat = 'microseconds' | 'milliseconds' | 'seconds';

/**
 * Whether execution-time profiling is on by default, from the `IMQ_LOG_TIME`
 * environment variable.
 *
 * @remarks
 * The value is coerced numerically: any non-zero number enables it, while `0`, an
 * empty value, or any non-numeric string — including `true` — disables it. Use
 * `IMQ_LOG_TIME=1`.
 *
 * Read once when the module is first imported, so later changes to `process.env`
 * are ignored. Individual decorators override this via
 * {@link ProfileDecoratorOptions.enableDebugTime}.
 */
export const IMQ_LOG_TIME: boolean = !!+(process.env.IMQ_LOG_TIME || 0);

/**
 * Whether call-argument profiling is on by default, from the `IMQ_LOG_ARGS`
 * environment variable.
 *
 * @remarks
 * Coerced numerically exactly as {@link IMQ_LOG_TIME} is, with the same caveat
 * that `IMQ_LOG_ARGS=true` evaluates to disabled — use `IMQ_LOG_ARGS=1`.
 *
 * Read once when the module is first imported. Individual decorators override
 * this via {@link ProfileDecoratorOptions.enableDebugArgs}.
 */
export const IMQ_LOG_ARGS: boolean = !!+(process.env.IMQ_LOG_ARGS || 0);

/**
 * Unit used when rendering profiled execution time, from the
 * `IMQ_LOG_TIME_FORMAT` environment variable. Accepts `microseconds`,
 * `milliseconds` or `seconds`, and defaults to `microseconds`.
 *
 * @remarks
 * The value is not validated, so any unrecognized string falls back to
 * `microseconds` silently. Read once when the module is first imported and
 * applied globally — there is no per-decorator or per-call override.
 *
 * Output is rendered as `<n> μs` (unrounded), `<n.nnn> ms`, or `<n.nnn> sec`.
 */
export const IMQ_LOG_TIME_FORMAT: AllowedTimeFormat =
    (process.env.IMQ_LOG_TIME_FORMAT as AllowedTimeFormat) || 'microseconds';

/**
 * Fully-resolved description of a single profiled call, as passed to
 * {@link logDebugInfo}.
 *
 * Normally constructed by the {@link profile} decorator; supply it directly only
 * to emit profiling output by hand. Every field except `logger` is required.
 */
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
     * Nanosecond-resolution start reading, as returned by
     * `process.hrtime.bigint()`.
     *
     * @remarks
     * A `number` is accepted but must be an integral nanosecond count: a
     * non-integer throws a `RangeError`, and a millisecond timestamp such as
     * `Date.now()` produces a meaningless duration.
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
 * Emits the profiling output for a single call: the elapsed time computed from
 * `input.start`, and/or the call arguments serialized as indented JSON.
 *
 * @param input - fully-resolved description of the profiled call
 *
 * @remarks
 * Nothing is written when no logger is supplied, or when the logger does not
 * implement the requested level — the work is still done, silently.
 *
 * Circular and merely repeated object references are omitted from the argument
 * dump. If the arguments cannot be serialized at all (a `BigInt`, for example),
 * the failure is reported through `logger.error` regardless of the configured
 * level and the arguments are logged as an empty string.
 */
export function logDebugInfo(input: DebugInfoOptions) {
    const {
        debugTime,
        debugArgs,
        className,
        args,
        methodName,
        start,
        logger,
        logLevel,
    } = input;
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
 * @param target - the decorated call target
 * @returns the resolved class name, or an empty string when it cannot be
 *          determined
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
 * @param target - the decorated target object
 * @returns the target's logger, or `undefined` when it carries none — including
 *          for a static call, where the target is a function rather than an
 *          instance
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
 * @param value - the value to test
 * @returns true when the value exposes a callable `then` method
 */
function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}

/**
 * Wraps a class method so that its execution time and/or its call arguments are
 * logged through the `logger` property of the decorated instance.
 *
 * @param options - profiling options; omitted fields fall back to the
 *        {@link IMQ_LOG_TIME}, {@link IMQ_LOG_ARGS} and {@link IMQ_LOG_LEVEL}
 *        environment defaults
 * @returns a dual-mode method decorator. Under standard (TC39) decorators it is
 *          called as `(method, context)` and returns the replacement method;
 *          under legacy decorators it is called as
 *          `(target, propertyKey, descriptor)`, replaces `descriptor.value` and
 *          returns that same descriptor object. Only method decoration is
 *          supported.
 *
 * @example
 * ```typescript
 * import { profile } from '@imqueue/core';
 *
 * class MyClass {
 *     // the decorator logs through this property only;
 *     // without a logger nothing is ever written
 *     public logger = console;
 *
 *     // always profiled, whatever IMQ_LOG_TIME / IMQ_LOG_ARGS say
 *     @profile({ enableDebugTime: true, enableDebugArgs: true })
 *     public myMethod() {
 *         // ...
 *     }
 *
 *     // profiled only when IMQ_LOG_TIME=1 and/or IMQ_LOG_ARGS=1
 *     @profile()
 *     private innerMethod() {
 *         // ...
 *     }
 * }
 * ```
 *
 * @remarks
 * Output is written through the decorated instance's `logger` property (any
 * {@link ILogger}). If the instance has no `logger`, or its logger lacks the
 * selected level method, profiling runs and produces no output at all — no
 * warning is emitted. Static methods are never logged, because the logger is
 * looked up on instances only.
 *
 * Async methods are handled: when the wrapped method returns a thenable, logging
 * is deferred until it settles and the measured time covers the full
 * asynchronous duration. The original promise is returned unchanged, so identity,
 * chaining and rejection propagation are unaffected. A rejection is logged with
 * the same message as a success — the error itself is neither included nor
 * captured.
 *
 * The wrapper is installed unconditionally; when profiling is disabled it
 * delegates straight to the original method. Because decoration replaces the
 * method, its `name` becomes `"wrapper"` and its `length` becomes `0` — do not
 * rely on the reflected name or arity of a profiled method. Whether timing and
 * argument logging are enabled is resolved once, when the class is defined.
 *
 * Precedence: `enableDebugTime` and `enableDebugArgs` override the environment
 * defaults only when passed as real booleans; any other value is ignored.
 * `logLevel` overrides {@link IMQ_LOG_LEVEL}, but an unrecognized level resolves
 * to `info` rather than falling back to the environment value.
 *
 * Under legacy decorators the supplied property descriptor is mutated in place.
 * Only method decoration is supported: applied to anything else it either throws
 * a `TypeError` (legacy form, no descriptor) or installs the wrapper in the wrong
 * slot (standard form — `context.kind` is not validated).
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
