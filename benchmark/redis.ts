/*!
 * Redis message-queue adapter benchmark test
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
import IMQ, { IMQOptions, IJson } from '..';

function bytes(str: string) {
    return Buffer.from(str, 'utf8').length;
}

(async() => {
    try {
        const queueName = 'TestIMQ';
        const options: Partial<IMQOptions> = { vendor: 'Redis' };
        const [mq, mq2] = await Promise.all([
            IMQ.create(queueName, options).start(),
            IMQ.create(queueName, options).start()
        ]);
        const jsonExample: IJson = {
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
                            "MoreBytes": [0,1,2,3,4,5,6],
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

        let count = 0;
        const STEPS = 10000;
        const fmt = new Intl.NumberFormat(
            'en-US', { maximumSignificantDigits: 3 }
        );

        mq.on('message', (...args: any[]) => count++);
        mq2.on('message', (...args: any[]) => count++);

        console.log('Sending %s messages, please, wait...', fmt.format(STEPS));

        const start = Date.now();

        for (let i = 0; i < STEPS; i++) {
            mq2.send(queueName, jsonExample).catch();
        }

        const interval = setInterval(async () => {
            if (count >= STEPS) {
                const time = Date.now() - start;

                console.log(
                    '%s is sent/received in %s ±10 ms',
                    fmt.format(count),
                    fmt.format(time)
                );
                console.log(
                    'Round-trip ratio: %s messages/sec',
                    fmt.format(count / (time / 1000))
                );
                console.log(
                    'Message payload is: %s bytes',
                    fmt.format(bytes(JSON.stringify(jsonExample)))
                );

                mq.destroy();
                mq2.destroy();

                clearInterval(interval);
            }
        }, 10);
    }

    catch (err) {
        console.error(err.stack);
    }
})();
