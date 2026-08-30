# I Message Queue (@imqueue/core)

[![Build Status](https://img.shields.io/github/actions/workflow/status/imqueue/core/build.yml)](https://github.com/imqueue/core/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/@imqueue/core)](https://www.npmjs.com/package/@imqueue/core)
[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://github.com/imqueue/core/blob/master/LICENSE)

Simple JSON-based messaging queue for inter-service communication in Node.js &
TypeScript back-ends — the Redis-backed transport that powers the @imqueue
framework. Fast, poll-free delivery with optional guaranteed mode.

**Documentation:** full guides, tutorial and API reference at
[imqueue.org](https://imqueue.org/). Commercial licensing & support for
closed-source products at [imqueue.com](https://imqueue.com/).

**Using an AI assistant?** Point it at [imqueue.org/llms.txt](https://imqueue.org/llms.txt)
for a machine-readable index of the docs, or see [AGENTS.md](./AGENTS.md). Current
version, licence and Node floor for every package:
[imqueue.org/status.json](https://imqueue.org/status.json).

**Related packages:**

- [@imqueue/rpc](https://github.com/imqueue/rpc) - RPC-like client/service
  implementation over @imqueue/core.
- [@imqueue/cli](https://github.com/imqueue/cli) - Command Line Interface
  for imqueue.

# Features

With current implementation on RedisQueue:

- **Fast, unreliable** message delivery (if a consumer grabs the message and dies,
  the message will be lost). Up to ~35–40k of 1Kb messages per second on an i7 core
  by benchmarks.
- **Fast, guaranteed** message delivery (only 1.5–2 times slower than
  unreliable mode). If a consumer grabs a message and dies, it will be rescheduled
  to the queue. Up to ~20–25k of 1Kb messages per second on an i7 core by benchmarks.
- **No timers or constant Redis polling** used for implementation, resulting in
  no delays in delivery and low CPU usage on application workers. When idle,
  it consumes no resources.
- **Supports Gzip compression for messages** (decreases traffic usage but is slower).
- **Concurrent workers model supported**, the same queue can have multiple
  consumers.
- **Delayed messages supported**, fast as ~10K of 1Kb messages per second on i7
  core by benchmarks.
- **Safe, predictable scaling of queues**. Scaling the number of workers does not
  increase traffic usage.
- **Round-robin message balancing between multiple Redis instances**. This
  allows easy horizontal scaling of the messaging queue across Redis instances.
- **TypeScript included!**

# Requirements

Currently this module has only one available adapter, which is Redis. Redis server
6.2+ is required, because safe (guaranteed) delivery moves each message with the
`LMOVE`/`BLMOVE` commands, which arrived in 6.2. Unreliable delivery uses `BRPOP`
alone and runs on 3.2+, so an older server is only enough if `safeDelivery` stays
off — which is not what most deployments want.

If the config command is disabled on Redis, you must manually enable keyspace
notification events (particularly when using AWS ElasticCache), like this:

```
notify-keyspace-events Ex
```

Otherwise the queue configures them itself, and does so without disturbing your
own setup: it reads `notify-keyspace-events`, appends only the flags it is
missing (`E` and `x`) and leaves everything else — including flags enabled by
an operator or by other code sharing the same Redis — in place. Any superset of
`Ex` is accepted as is, so no `CONFIG SET` is issued at all.

More adapters will be added in the future as needed.

# Install

```bash
npm i --save @imqueue/core
```

# Usage

```typescript
import IMQ, { IMessageQueue, IJson } from '@imqueue/core';

(async () => {
    const queueOne: IMessageQueue = IMQ.create('QueueOne');
    const queueTwo: IMessageQueue = IMQ.create('QueueTwo');

    // start queues
    await queueOne.start();
    await queueTwo.start();

    // handle queue messages
    queueOne.on('message', (message: IJson, id: string, fromQueue: string) => {
        console.log('queueOne message received:', message, id, fromQueue);

        if (message.delay) {
            queueOne.destroy();
            queueTwo.destroy();
        }
    });
    queueTwo.on('message', (message: IJson, id: string, fromQueue: string) => {
        console.log('queueTwo message received:', message, id, fromQueue);
    });

    // sending queue messages
    await queueOne.send('QueueTwo', { hello: 'two' });
    await queueTwo.send('QueueOne', { hello: 'one' });

    // sending delayed messages
    const delay = 1000;
    await queueOne.send('QueueOne', { delay }, delay);
})();
```

# Guaranteed delivery

`safeDelivery` moves a message atomically out of the queue into a worker-owned
key as it is popped, and keeps it there until the message has been handled. A
worker that dies at any point before then — before it starts, or halfway through
the handler — leaves the message behind to be re-queued rather than taking it
down.

**How a listener says it has finished is its return value.** Return a promise and
the message stays checked out until it settles:

```typescript
const queue = IMQ.create('Orders', { safeDelivery: true });

queue.on('message', async (message, id, fromQueue) => {
    await handle(message);      // the message is checked out for all of this
});
```

Return anything else and the message is released as the listener returns. Every
registered listener is consulted, and the message is released once all the
promises they returned have settled — settled, not fulfilled: a handler that
throws has still had its turn, and re-delivering on a rejection would retry a
poison message forever.

That return value is also the lever for opting out. To have a message released
at dispatch, as releases before 4.0 did, simply do not return its promise:

```typescript
queue.on('message', message => {
    void handle(message);       // released immediately; a crash loses it
});
```

`safeDeliveryTtl` is not that lever and never was — the key used to be deleted
at dispatch, so no value of it bounded a dispatched message's lifetime then, and
none bounds one now.

| option | default | meaning |
|---|---|---|
| `safeDelivery` | `false` | move messages through a worker-owned key, held until handled |
| `safeDeliveryTtl` | `300000` | the longest a message may be worked on |

A message comes back on either of two counts, because there are two ways to lose
one.

The **process dying** is caught by the broker: the worker key names the process
that took it, and the watcher reclaims the lease once that process leaves
`CLIENT LIST`. That is a fact the broker holds rather than an inference from a
clock, so it is noticed as fast as the socket closes, and nothing has to be
renewed to keep a live lease alive. Workers riding out a reconnect get one sweep
of grace, and if the client list cannot be read at all, leases are left to their
budget rather than guessed at.

**One handler wedging** is caught by `safeDeliveryTtl`, and only by it. A worker
can be up, connected and happily serving other messages while one handler is
stuck forever — liveness cannot see that, and restarting an otherwise healthy
process is not a recovery strategy. Set the budget to the longest a handler in
your system can legitimately take, with headroom: a slow upstream is the usual
reason for a large value — a data vendor with no job API, screen-scraping behind
an HTTP call, anything that can run for minutes. Set it too low and a message is
reclaimed from a worker still legitimately working on it.

Two internals deliberately do not scale with this value. The maintenance sweep
runs on `watcherCheckDelay` (5 s by default), so a dead worker is still found
within seconds however generous the budget — that, not `safeDeliveryTtl`, is the
latency for a crashed worker's message coming back. And the reader's blocking
pop is half the budget capped at 5 s, so a message is not born having already
spent much of it.

Delivery is **at-least-once** in every mode. Holding the lease narrows the window
in which in-flight work is lost — it does not close it, and `SIGKILL` on the
whole node, an OOM kill or a lost machine still take work with them — so handlers
must be idempotent.

# Benchmarking

First, make sure redis-server is running on localhost. The current version of the
benchmark requires Redis to be running on localhost so it can measure its CPU
usage statistics.

All workers during the benchmark test will have dedicated CPU affinity to ensure
the collected statistics are as accurate as possible.

```bash
git clone git@github.com:imqueue/core.git
cd core
node benchmark -c 4 -m 10000
```

Other possible benchmark options:

```
node benchmark -h
Options:
  --version                     Show version number                    [boolean]
  -h, --help                    Show help                              [boolean]
  -c, --children                Number of children test process to fork
  -d, --delay                   Number of milliseconds to delay message delivery
                                for delayed messages. By default delayed
                                messages is of and this argument is equal to 0.
  -m, --messages                Number of messages to be sent by a child process
                                during test execution.
  -z, --gzip                    Use gzip for message encoding/decoding.[boolean]
  -s, --safe                    Use safe (guaranteed) message delivery
                                algorithm.                             [boolean]
  -e, --example-message         Path to a file containing JSON of example
                                message to use during the tests.
  -p, --port                    Redis server port to connect to.
  -t, --message-multiply-times  Increase sample message data given number of
                                times.
```

The number of child workers running message queues is limited to the number of CPUs
in the system minus 2. The first CPU (CPU0) is reserved for OS tasks and the stats
collector process. The second CPU (CPU1) is dedicated to the local Redis process.
All others are available to run queue workers.

For example, on an 8-core machine you can safely run up to 6 workers. On a 4-core
machine, this limit is 2 workers. If there are fewer cores, the results will not
provide good visibility of the load.

**NOTE:** The paragraphs above apply to Linux only. On macOS there is no reliable way
to set process CPU affinity, and Windows support is not currently implemented for
benchmarking. This does not mean the benchmark won't work on macOS or Windows, but
the results will not be accurate or predictable on those platforms.

## Running Unit Tests

Tests run on the native Node.js test runner (`node:test`) with `node:assert` and
no external test framework, so a plain clone and install is all that is needed:

```bash
git clone git@github.com:imqueue/core.git
cd core
npm install
npm test
```

To produce a coverage report use:

```bash
npm run test-coverage        # prints coverage summary to the console
npm run test-lcov            # writes coverage/lcov.info
```

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](LICENSE)
