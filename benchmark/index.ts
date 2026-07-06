/*!
 * Benchmark tests for @imqueue/core module
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
import cluster from 'cluster';
import { execSync as exec } from 'child_process';
import { arch, cpus, freemem, platform, totalmem } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { run } from './redis-test';
import { resolve } from 'path';
import { randomUUID as uuid } from 'crypto';
import { AnyJson } from '..';
import { setAffinity } from './affinity';

/**
 * Command line options: canonical long name -> parseArgs config and description
 * used to render `--help`.
 */
const OPTIONS: {
    [name: string]: {
        type: 'string' | 'boolean';
        short: string;
        describe: string;
    };
} = {
    help: {
        type: 'boolean',
        short: 'h',
        describe: 'Show this help.',
    },
    children: {
        type: 'string',
        short: 'c',
        describe: 'Number of children test process to fork.',
    },
    delay: {
        type: 'string',
        short: 'd',
        describe:
            'Number of milliseconds to delay message delivery for ' +
            'delayed messages. By default delayed messages is off and this ' +
            'argument is equal to 0.',
    },
    messages: {
        type: 'string',
        short: 'm',
        describe:
            'Number of messages to be sent by a child process ' +
            'during test execution.',
    },
    gzip: {
        type: 'boolean',
        short: 'z',
        describe: 'Use gzip for message encoding/decoding.',
    },
    safe: {
        type: 'boolean',
        short: 's',
        describe: 'Use safe (guaranteed) message delivery algorithm.',
    },
    'example-message': {
        type: 'string',
        short: 'e',
        describe:
            'Path to a file containing JSON of example message to ' +
            'use during the tests.',
    },
    port: {
        type: 'string',
        short: 'p',
        describe: 'Redis server port to connect to.',
    },
    'message-multiply-times': {
        type: 'string',
        short: 't',
        describe:
            'Increase sample message data given number of times per ' +
            'request.',
    },
};

/**
 * Command line args
 */
const ARGV: any = parseArgs({
    options: Object.fromEntries(
        Object.entries(OPTIONS).map(([name, { type, short }]) => [
            name,
            { type, short },
        ]),
    ) as any,
    allowPositionals: true,
}).values;

if (ARGV.help) {
    const help = Object.entries(OPTIONS)
        .map(([name, o]) => `  -${o.short}, --${name}\n        ${o.describe}`)
        .join('\n\n');

    process.stdout.write(
        `Usage: node benchmark [options]\n\nOptions:\n${help}\n`,
    );
    process.exit(0);
}

let maxChildren = Number(ARGV.children) || 1;

const METRICS_DELAY = 100;
const CPUS = cpus();
const numCpus = CPUS.length;
const CPU_NAMES = ['Redis Process, CPU Used, %'];
const STEPS = Number(ARGV.messages) || 10000;
const MSG_DELAY = Number(ARGV.delay) || 0;
const USE_GZIP: boolean = !!ARGV.gzip;
const MSG_MULTIPLIER = Number(ARGV['message-multiply-times']) || 0;
const SAFE_DELIVERY: boolean = !!ARGV.safe;
const REDIS_PORT: number = Number(ARGV.port) || 6379;

let SAMPLE_MESSAGE: AnyJson;

if (ARGV['example-message']) {
    try {
        SAMPLE_MESSAGE = JSON.parse(
            readFileSync(ARGV['example-message'] + '').toString(),
        );

        if (MSG_MULTIPLIER) {
            SAMPLE_MESSAGE = Array.from(
                { length: MSG_MULTIPLIER },
                () => SAMPLE_MESSAGE,
            );
        }
    } catch {
        console.warn(
            'Given example message is invalid, ' +
                'proceeding test execution with with standard ' +
                'example message.',
        );
    }
}

if (numCpus - 2 < maxChildren) {
    maxChildren = numCpus - 2;
}

if (!maxChildren) {
    maxChildren = 1;
}

for (let i = 0; i < maxChildren; i++) {
    CPU_NAMES.push(`IMQ worker #${i + 1}, CPU Used, %`);
}

/**
 * Returns usage metrics for a given CPU
 *
 * @param {number} i
 * @returns {{idle: number, total: number}}
 */
function cpuAvg(i: number): { idle: number; total: number; } {
    const cpuList = cpus();
    const cpu: any = cpuList[i];
    let totalIdle = 0;
    let totalTick = 0;

    for (let type in cpu.times) {
        totalTick += cpu.times[type];
    }

    totalIdle += cpu.times.idle;

    return {
        idle: totalIdle / cpus.length,
        total: totalTick / cpus.length,
    };
}

interface MachineStats {
    stats: any[];
    memStats: any[];
}

interface BuildStatsInput {
    metrics: any[];
    memusage: any[];
}

/**
 * Does stat aggregation and returns results
 *
 * @param {BuildStatsInput} input
 * @return {MachineStats}
 */
function buildStats({ metrics, memusage }: BuildStatsInput): MachineStats {
    const stats: any[] = [];
    const memStats: any[] = ['System Memory Used, %'];

    for (let i = 1, s = metrics.length; i < s; i++) {
        for (let cpu = 0, ss = CPU_NAMES.length; cpu < ss; cpu++) {
            const idle = metrics[i][cpu].idle - metrics[i - 1][cpu].idle;
            const total = metrics[i][cpu].total - metrics[i - 1][cpu].total;

            if (!stats[cpu]) {
                stats[cpu] = [CPU_NAMES[cpu]];
            }

            stats[cpu].push(100 - ~~((100 * idle) / total));
        }
    }

    for (let i = 0, s = memusage.length; i < s; i++) {
        memStats.push(100 - ~~((100 * memusage[i].free) / memusage[i].total));
    }

    return { stats, memStats };
}

interface ChartConfig {
    bindto: string;
    data: { columns: any[] };
    point: { show: boolean };
    axis: {
        x: {
            type: string;
            categories: any;
            tick: {
                centered: boolean;
                fit: boolean;
                culling: { max: number };
                outer: boolean
            }
        };
        y: { max: number; tick: { outer: boolean } }
    };
    zoom: { enabled: boolean };
}

/**
 * Returns chart config for given chart id and stats
 *
 * @param {string} id
 * @param {any[]} stats
 * @return {ChartConfig}
 */
function buildChartConfig(id: string, stats: any[]): ChartConfig {
    return {
        bindto: `#${id}`,
        data: {
            columns: stats,
        },
        point: { show: false },
        axis: {
            x: {
                type: 'category',
                categories: stats[0]
                    .slice(1)
                    .map(
                        (_: any, i: number) =>
                            (((i * 100) / 1000).toFixed(1) + 's'),
                    ),
                tick: {
                    centered: true,
                    fit: false,
                    culling: { max: 20 },
                    outer: false,
                },
            },
            y: {
                max: 100,
                tick: { outer: false },
            },
        },
        zoom: {
            enabled: true,
        },
    };
}

/**
 * Return byte count for a given data and bytes key
 *
 * @param {any[]} data
 * @param {Intl.NumberFormat} fmt
 * @param {string} key
 * @return {string}
 */
function bytesCount(data: any[], fmt: Intl.NumberFormat, key: string): string {
    return fmt.format(
        Math.round(
            data.reduce((prev, next) => prev + next[key], 0) / data.length,
        ),
    );
}

/**
 * Prepares and saves stats from a given collected metrics
 *
 * @param {{ metrics: any, memusage: any }} stats
 * @param {any} data
 */
function saveStats({ metrics, memusage }: any, data: any[]) {
    const { stats, memStats } = buildStats({ metrics, memusage });
    const config = buildChartConfig('cpu-usage', stats);
    const memConfig = buildChartConfig('memory-usage', [memStats]);
    const fmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

    // language=HTML
    let html = `<!doctype html>
<html lang="en">
<head>
    <title>IMQ Benchmark results</title>
    <meta charset="utf-8">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/3.5.17/d3.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/c3/0.4.21/c3.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/c3/0.4.21/c3.min.css">
</head>
<body>
    <h1>IMQ Benchmark Results</h1>
     <p>This test was executed using a CPU affinity assignment for each running 
    process. Redis server has its own dedicated CPU core, all worker processes
    are attached to their own cores as well. Each worker process running a bunch
    of requests simultaneously in an asynchronous manner, so depending on the
    given test parameters, all requests are executed almost at the same time.
    <blockquote>
    <i>NOTE: In macOS it is not possible to implement CPU affinity assignment for
    a given process, so there is no way to guaranty a proper process load
    visibility.</i>
    </blockquote>
    </p>
    <h2 class="title">Test Execution Information</h2>
    <ul>
        <li>Execution Datetime: <i>${new Date().toISOString()}</i></li>
        <li>System Info:
            <ul>
                <li>CPU: ${CPUS[0].model} &times; ${numCpus} cores</li>
                <li>CPU Clock Speed: ${CPUS[0].speed}Mhz</li>
                <li>RAM: ${Math.ceil(totalmem() / Math.pow(1024, 3))}GB</li>
                <li>OS Architecture: ${arch()}</li>
                <li>OS Platform: ${platform()}</li>
                <li>Node Version: ${process.versions.node}</li>
            </ul>
        </li>
        <li>Number of workers: ${fmt.format(maxChildren)}</li>
        <li>Number of messages per worker: ${fmt.format(STEPS)}</li>
        <li>Total messages executed: ${fmt.format(STEPS * maxChildren)}</li>
        <li>Round-trip ratio across all workers is: <b>${fmt.format(
            data.reduce((prev, next) => prev + next.ratio, 0),
        )} msg/sec</b></li>
        <li>Average message payload to redis is: ${bytesCount(
            data,
            fmt,
            'bytesLen',
        )} bytes</li>
        <li>Average source message payload is: ${bytesCount(
            data,
            fmt,
            'srcBytesLen',
        )} bytes</li>
        <li>The average time of all messages deliveries is: ${fmt.format(
            Number(
                (
                    data.reduce((prev, next) => prev + next.time, 0) /
                    1000 /
                    data.length
                ).toFixed(2),
            ),
        )} sec ±10 ms</li>
        <li>Max delivery time is: ${fmt.format(
            Number(
                (
                    Math.max.apply(
                        null,
                        data.map(item => item.time),
                    ) / 1000
                ).toFixed(2),
            ),
        )} sec ±10 ms</li>
        ${MSG_DELAY ? '<li>Message delivery delay used: ' + MSG_DELAY + '</li>' : ''}
        <li>Gzip compression for messages is: <b>${USE_GZIP ? 'On' : 'Off'}</b></li>
        <li>Safe delivery is: <b>${SAFE_DELIVERY ? 'On' : 'Off'}</b></li>
    </ul>
    <h2 class="title">CPU Usage</h2>
    <div class="chart">
        <div id="cpu-usage"></div>
    </div>
    <h2 class="title">Memory Usage</h2>
    <div class="chart">
        <div id="memory-usage"></div>
    </div>
    <script>
    c3.generate(${JSON.stringify(config)});
    c3.generate(${JSON.stringify(memConfig)});
    </script>
</body>
</html>
`;
    const htmlFile = resolve(__dirname, `../benchmark-result/${uuid()}.html`);

    if (!existsSync('./benchmark-result')) {
        mkdirSync('./benchmark-result');
    }

    writeFileSync(htmlFile, html, { encoding: 'utf8' });

    console.info('Benchmark stats saved!');
    console.info(`Opening file://${htmlFile}`);

    import('open').then(open =>
        open.default(`file://${htmlFile}`, { wait: false }),
    );
    process.exit(0);
}

// main program:

if (cluster.isPrimary) {
    setAffinity(1);

    const statsWorker = cluster.fork();
    statsWorker.send('stats');

    let done: number = 0;
    const data: any[] = [];

    statsWorker.on('message', (msg: any) => {
        if (msg.startsWith('metrics:')) {
            saveStats(JSON.parse(msg.split('metrics:').pop() || ''), data);
            process.exit(0);
        }
    });

    for (let i = 0; i < maxChildren; i++) {
        const worker = cluster.fork();

        worker.send(`imq ${i}`);
        worker.on('message', (msg: string) => {
            if (msg.startsWith('data:')) {
                done++;
                data.push(JSON.parse(msg.split('data:').pop() || ''));

                if (done >= maxChildren) {
                    statsWorker.send('stop');
                }
            }
        });
    }
} else {
    const metrics: any[] = [];
    const memusage: any[] = [];
    let metricsInterval: any;

    process.on('message', async (msg: string) => {
        if (msg.startsWith('imq')) {
            const index = parseInt(String(msg.split(/\s+/).pop()), 10);
            const core = numCpus <= 2 ? 1 : index + 2;

            setAffinity(core);

            try {
                const data = await run(
                    REDIS_PORT,
                    STEPS,
                    MSG_DELAY,
                    USE_GZIP,
                    SAFE_DELIVERY,
                    SAMPLE_MESSAGE,
                );
                (<any>process).send('data:' + JSON.stringify(data));
            } catch (err) {
                (<any>process).send('data:' + JSON.stringify(null));
                console.error(err instanceof Error ? err.stack : err);
                process.exit(1);
            }
        } else if (msg === 'stats') {
            setAffinity(1);

            const redisProcess = exec('ps ax|grep redis-server')
                .toString('utf8')
                .split(/\r?\n/)[0];
            const core = numCpus > 1 ? 1 : 0;

            if (
                core &&
                platform() === 'linux' &&
                /redis-server/.test(redisProcess) &&
                !/grep/.test(redisProcess)
            ) {
                const redisPid = parseInt(redisProcess.split(/\s+/)[0], 10);
                if (redisPid) {
                    exec(`taskset -cp ${core} ${redisPid}`);
                }
            }

            metricsInterval = setInterval(() => {
                metrics.push(
                    CPU_NAMES.map((_, i: number) => cpuAvg(i + 1)),
                );
                memusage.push({
                    total: totalmem(),
                    free: freemem(),
                });
            }, METRICS_DELAY);
        } else if (msg === 'stop') {
            if (metricsInterval) {
                clearInterval(metricsInterval);
            }
            metricsInterval = null;
            console.info('Finalizing...');
            (<any>process).send(
                'metrics:' +
                    JSON.stringify({
                        metrics,
                        memusage,
                    }),
            );

            process.exit(0);
        }
    });
}
