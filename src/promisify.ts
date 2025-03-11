/*!
 * Makes callback handling function promise-like
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

/**
 * Returns entire list of the given object properties including
 * entire prototype chain
 *
 * @param {any} obj
 * @returns {string[]}
 */
export function propertiesOf(obj: any): string[] {
    const props: string[] = [];

    // noinspection JSAssignmentUsedAsCondition
    do {
        Object.getOwnPropertyNames(obj).forEach((prop) => {
            if (!~props.indexOf(prop)) {
                props.push(prop);
            }
        });
    } while (obj = Object.getPrototypeOf(obj));

    return props;
}

// istanbul ignore next
/**
 * Makes a callback function able to resolve or reject with given
 * resolve and reject functions
 *
 * @param {(...args: any[]) => any} resolve
 * @param {(...args: any[]) => any} reject
 * @return {(...args: any[]) => any}
 */
function makeCallback(
    resolve: (...args: any[]) => any,
    reject: (...args: any[]) => any,
): (...args: any[]) => any {
    return function callback(err: Error, ...args: any[]) {
        if (err) {
            return reject(err);
        }

        resolve(args.length === 1 ? args[0] : args);
    };
}

// istanbul ignore next
/**
 * Makes given method promised
 *
 * @access private
 * @param {(...args: any[]) => any} method
 * @return {(...args: any[]) => Promise<any>}
 */
function makePromised(method: (...args: any[]) => any) {
    return function asyncMethod(...args: any[]): Promise<any> {
        const callback = args[args.length - 1];

        if (typeof callback === 'function') {
            return method.apply(this, args);
        }

        return new Promise<any>((resolve, reject) => {
            method.call(this, ...args, makeCallback(resolve, reject));
        });
    };
}

/**
 * Makes given object methods promise-like
 *
 * @param {any} obj - source object to modify
 * @param {string[]} restrict - stick promise-like behavior to a given
 *                              restricted list of methods
 * @return {void}
 */
export function promisify(obj: any, restrict?: string[]): void {
    for (const prop of propertiesOf(obj)) {
        try {
            if (typeof obj[prop] !== 'function' ||
                (restrict && !~restrict.indexOf(prop.toLowerCase()))
            ) {
                continue;
            }
        } catch (err) {
            /* istanbul ignore next */
            continue;
        }

        obj[prop] = makePromised(obj[prop]);
    }
}
