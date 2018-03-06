import * as mw from 'memwatch-next';
import IMQ, { IMQOptions, IJson, uuid } from '..';
import { execSync as exec } from 'child_process';
import * as cluster from 'cluster';
import * as os from 'os';
import * as fs from 'fs';
import * as yargs from 'yargs';

const ARGV = yargs
    .help('h')
    .alias('h', 'help')

    .alias('c', 'children')
    .describe('c', 'Number of children test process to fork')

    .alias('m', 'messages')
    .describe('m', 'number of messages to be sent by a child process ' +
        'during test execution')

    .boolean(['h'])
    .argv;

const na = require('nodeaffinity');

mw.on('leak', (info) => console.error('Memory leak detected:\n', info));

const METRICS_DELAY = 100;

const CPUS = os.cpus();
const numCpus = CPUS.length;
const CPU_NAMES = ['redis'];

let maxChildren = Number(ARGV.c) || 1;

if (numCpus - 2 < maxChildren) {
    maxChildren = numCpus - 2;
}

if (!maxChildren) {
    maxChildren = 1;
}

for (let i = 0; i < maxChildren; i++) {
    CPU_NAMES.push(`imq${i + 1}`);
}

// CPU0 - stats
// CPU1 - redis
// CPU2..N - imq

function bytes(str: string) {
    return Buffer.from(str, 'utf8').length;
}

function cpuAvg(i: number) {
    const cpus = os.cpus();
    const cpu: any = cpus[i];
    let totalIdle = 0;
    let totalTick = 0;

    for (let type in cpu.times) {
        totalTick += cpu.times[type];
    }

    totalIdle += cpu.times.idle;

    return {
        idle: totalIdle / cpus.length,
        total: totalTick / cpus.length
    };
}

function printStats(metrics: any[]) {
    const stats: any[] = [];

    for (let i = 1, s = metrics.length; i < s; i++) {
        for (let cpu = 0, ss = CPU_NAMES.length; cpu < ss; cpu++) {
            const idle = metrics[i][cpu].idle - metrics[i - 1][cpu].idle;
            const total = metrics[i][cpu].total - metrics[i - 1][cpu].total;

            if (!stats[cpu]) {
                stats[cpu] = [CPU_NAMES[cpu]];
            }

            stats[cpu].push(100 - ~~(100 * idle / total));
        }
    }

    const config = {
        data: {
            columns: stats
        },
        axis: {
            x: {
                type: 'category',
                categories: stats[0].slice(1).map((v: any, i: number) =>
                    (i * 100) + 'ms')
            }
        },
        zoom: {
            enabled: true
        }
    };

    fs.writeFileSync('./stats.json', JSON.stringify(config));
    console.log('CPU stats saved to stats.json file.');
}

async function runTest() {
    return new Promise(async (resolve) => {
        const queueName = `imq-test:${uuid()}`;
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

        let count = 0;
        const STEPS = Number(ARGV.m) || 10000;
        const fmt = new Intl.NumberFormat(
            'en-US', { maximumSignificantDigits: 3 }
        );

        mq.on('message', () => count++);
        mq2.on('message', () => count++);

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
                resolve();
            }
        }, 10);
    });
}

if (cluster.isMaster) {
    na.setAffinity(1);

    const statsWorker = cluster.fork();
    statsWorker.send('stats');

    const done: boolean[] = [];

    for (let i = 0; i < maxChildren; i++) {
        done[i] = false;
        const worker = cluster.fork();
        worker.send(`imq ${i}`);
        worker.on('message', (msg: string) => {
            const index = parseInt(String(msg.split(/\s+/).pop()), 10);
            done[index] = true;

            if (!~done.indexOf(false)) {
                statsWorker.send('stop');
                process.exit(0);
            }
        });
    }
}

else {
    const metrics: any[] = [];
    let metricsInterval: any;

    process.on('message', async (msg: string) => {
        if (/^imq/.test(msg)) {
            const index = parseInt(String(msg.split(/\s+/).pop()), 10);
            const mask = numCpus <= 2 ? 1 : Math.pow(2, index + 2);

            na.setAffinity(mask);

            try {
                await runTest();
            }

            catch (err) {
                console.error(err.stack);
                process.exit(1);
            }

            (<any>process).send(`img ${index}`);
            process.exit(0);
        }

        else if (msg === 'stats') {
            na.setAffinity(1);

            const redisProcess = exec('ps ax|grep redis-server')
                .toString('utf8')
                .split(/\r?\n/)[0];
            const mask = numCpus < 2 ? 1 : 2;

            if (/redis-server/.test(redisProcess) && !/grep/.test(redisProcess)) {
                const redisPid = parseInt(redisProcess.split(/\s+/)[0], 10);
                redisPid && exec(`taskset -p ${mask} ${redisPid}`);
            }

            metricsInterval = setInterval(() => {
                metrics.push(
                    CPU_NAMES.map((name: string, i: number) => cpuAvg(i + 1))
                );
            }, METRICS_DELAY)
        }

        else if (msg === 'stop') {
            metricsInterval && clearInterval(metricsInterval);
            printStats(metrics);
            process.exit(0);
        }
    });
}
