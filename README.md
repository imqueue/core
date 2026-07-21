# I Message Queue (@imqueue/core)

[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://rawgit.com/imqueue/core/master/LICENSE)

Simple JSON-based messaging queue for inter-service communication in Node.js &
TypeScript back-ends — the Redis-backed transport that powers the @imqueue
framework. Fast, poll-free delivery with optional guaranteed mode.

**Documentation:** full guides, tutorial and API reference at
[imqueue.org](https://imqueue.org/). Commercial licensing & support for
closed-source products at [imqueue.com](https://imqueue.com/).

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
6.2+ is required (the queue relies on `LMOVE`/`BLMOVE` commands for safe message
delivery).

If the config command is disabled on Redis, you must manually enable keyspace
notification events (particularly when using AWS ElasticCache), like this:

```
notify-keyspace-events Ex
```

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
