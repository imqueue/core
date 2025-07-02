/*!
 * Makes callback handling function promise-like
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
