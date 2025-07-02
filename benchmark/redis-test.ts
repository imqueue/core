/*!
 * Redis queue adapter benchmark tests for @imqueue/core module
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
import IMQ, {
    IMQOptions,
    IJson,
    uuid,
    pack,
    JsonObject, AnyJson,
} from '../index';

/**
 * Sample message used within tests
 */
const JSON_EXAMPLE: JsonObject = {
    "Glossary": {
        "Title": "Example Glossary",
        "GlossDiv": {
            "Title": "ß∆",
            "GlossList": [{
                "GlossEntry": {
                    "ID": "SGML",
                    "SortAs": "SGML",
                    "GlossTerm": "Standard Generalized Markup Language",
                    "Acronym": "SGML",
                    "Abbrev": "ISO 8879:1986",
                    "GlossDef": {
                        "para": "A meta-markup language, used to create markup languages such as DocBook.",
                        "GlossSeeAlso": ["GML", "XML"]
                    },
                    "GlossSee": "markup, non-markup, joke-cup"
                }
            }, {
                "GlossEntry": {
                    "ID": "SGML",
                    "SortAs": "SGML",
                    "GlossTerm": "Standard Generalized Markup Language",
                    "Acronym": "SGML",
                    "Abbrev": "ISO 8879:1986",
                    "MoreBytes": "",
                    "GlossDef": {
                        "para": "A meta-markup language, used to create markup languages such as DocBook.",
                        "GlossSeeAlso": ["GML", "XML", "FML", "RML", "FCL"]
                    },
                    "GlossSee": "markup"
                }
            }, {
                "GlossEntry": {
                    "ID": "SGML",
                    "SortAs": "SGML",
                    "GlossTerm": "Standard Generalized Markup Language",
                    "Acronym": "SGML",
                    "Abbrev": "ISO 8879:1986",
                    "MoreBytes": [0, 1, 2, 3, 4, 5, 6],
                    "GlossDef": {
                        "para": "A meta-markup language, used to create markup languages such as DocBook.",
                        "GlossSeeAlso": ["GML", "XML", "OGL", "PPL"]
                    },
                    "GlossSee": "markup"
                }
            }]
        }
    }
};

/**
 * Counts and returns byte-length in a given string
 *
 * @param {string} str
 * @param {boolean} useGzip
 * @returns {number}
 */
export function bytes(str: string, useGzip: boolean = false) {
    return Buffer.from(str, useGzip ? 'binary' : 'utf8').length;
}

/**
 * Test worker execution
 *
 * @param {number} port
 * @param {number} steps
 * @param {number} [msgDelay]
 * @param {boolean} [useGzip]
 * @param {boolean} safeDelivery
 * @param {IJson} jsonExample
 * @returns {Promise<any>}
 */
export async function run(
    port: number,
    steps: number,
    msgDelay: number = 0,
    useGzip: boolean = false,
    safeDelivery: boolean = false,
    jsonExample: AnyJson = JSON_EXAMPLE
) {
    const bytesLen = bytes(
        (useGzip ? pack : JSON.stringify)(jsonExample),
        useGzip
    );
    const srcBytesLen = bytes(JSON.stringify(jsonExample));

    return new Promise(async (resolve) => {
        const queueName = `imq-test:${uuid()}`;
        const options: Partial<IMQOptions> = {
            vendor: 'Redis',
            port,
            useGzip,
            safeDelivery
        };
        const mq = await IMQ.create(queueName, options).start();

        let count = 0;
        const fmt = new Intl.NumberFormat(
            'en-US', { maximumSignificantDigits: 3 }
        );

        mq.on('message', () => count++);

        if (msgDelay) {
            console.log(
                'Sending %s messages, using %s delay please, wait...',
                fmt.format(steps),
                fmt.format(msgDelay)
            );
        } else {
            console.log(
                'Sending %s messages, please, wait...',
                fmt.format(steps)
            );
        }

        const start = Date.now();

        for (let i = 0; i < steps; i++) {
            mq.send(queueName, jsonExample as JsonObject, msgDelay).catch();
        }

        const interval = setInterval(async () => {
            if (count >= steps) {
                const time = Date.now() - start;
                const ratio = count / (time / 1000);

                console.log(
                    '%s is sent/received in %s ±10 ms',
                    fmt.format(count),
                    fmt.format(time)
                );
                console.log(
                    'Round-trip ratio: %s messages/sec',
                    fmt.format(ratio)
                );
                console.log(
                    'Message payload is: %s bytes',
                    fmt.format(bytesLen)
                );

                mq.destroy().catch();

                clearInterval(interval);
                resolve({ count, time, ratio, bytesLen, srcBytesLen });
            }
        }, 10);
    });
}