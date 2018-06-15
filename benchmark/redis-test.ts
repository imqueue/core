/*!
 * Redis queue adapter benchmark tests for @imqueue/core module
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
import IMQ, { IMQOptions, IJson, uuid, pack } from '../index';

/**
 * Sample message used within tests
 */
const JSON_EXAMPLE: IJson = {
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
    jsonExample: IJson = JSON_EXAMPLE
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
            mq.send(queueName, jsonExample, msgDelay).catch();
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
