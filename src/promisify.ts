/*!
 * Makes callback handling function promise-like
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

import * as fs from 'fs';

/**
 * Returns entire list of the given object properties including
 * entire prototype chain
 *
 * @param {any} obj
 * @returns {string[]}
 */
export function propertiesOf(obj: any): string[] {
    const props: string[] = [];

    do {
        Object.getOwnPropertyNames(obj).forEach((prop) => {
            if (!~props.indexOf(prop)) {
                props.push(prop);
            }
        });
    } while (obj = Object.getPrototypeOf(obj));

    return props;
}

/**
 * Makes given object methods promise-like
 *
 * @param {{[p: string]: any}} obj
 * @param {string[]} restrict - stick promise-like behavior to a given
 *                              restricted list of methods
 */
export function promisify(
    obj: { [name: string]: any },
    restrict?: string[]
) {
    for (let prop of propertiesOf(obj)) {
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

        obj[prop] = ((method: Function) => function(...callArgs: any[]) {
            const callback = callArgs[callArgs.length - 1];

            if (typeof callback === 'function') {
                return method.apply(this, callArgs);
            }

            return new Promise((resolve, reject) => {
                method.call(this, ...callArgs,
                    function (err: Error, ...args: any[]) {
                        if (err) {
                            return reject(err);
                        }

                        resolve(args.length === 1 ? args[0] : args);
                    });
            });
        })(obj[prop]);
    }
}
