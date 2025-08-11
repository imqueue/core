# I Message Queue (@imqueue/core)

[![License](https://img.shields.io/badge/license-GPL-blue.svg)](https://rawgit.com/imqueue/core/master/LICENSE)

Simple JSON-based messaging queue for inter service communication

**Related packages:**

 - [@imqueue/rpc](https://github.com/imqueue/rpc) - RPC-like client/service
   implementation over @imqueue/core.
 - [@imqueue/cli](https://github.com/imqueue/cli) - Command Line Interface
   for imqueue.

# Features

With current implementation on RedisQueue:

 - **Fast unwarranted** message delivery (if consumer grab the message and dies 
   message will be lost). Up to ~35-40k of 1Kb messages per second on i7 core by
   benchmarks.
 - **Fast warranted** message delivery (only 1.5-2 times slower than 
   unwarranted). If consumer grab a message and dies it will be re-scheduled
   in queue. Up to ~20-25K of 1Kb messages per second on i7 core by benchmarks.
 - **No timers or constant redis polling** used for implementation, as result -
   no delays in delivery and low CPU usage on application workers. When idling
   it does not consume resources!
 - **Supports gzip compression for messages** (decrease traffic usage, but 
   slower).
 - **Concurrent workers model supported**, the same queue can have multiple
   consumers.
 - **Delayed messages supported**, fast as ~10K of 1Kb messages per second on i7 
   core by benchmarks.
 - **Safe predictable scaling of queues**. Scaling number of workers does not 
   influence traffic usage.
 - **Round-robin message balancing between several redis instances**. This
   allows easy messaging queue redis horizontal scaling.
 - **TypeScript included!**

# Requirements

Currently this module have only one available adapter which is Redis server
related. So redis-server > 3.8+ is required.

If config command is disabled on redis it will be required to turn on manually
keyspace notification events (actual on use with ElasticCache on AWS), like:

~~~
notify-keyspace-events Ex
~~~

Further, more adapters will be added... if needed.

# Install

~~~bash
npm i --save @imqueue/core
~~~

# Usage

~~~typescript
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
~~~

# Benchmarking

First of all make sure redis-server is running on the localhost. Current
version of benchmark supposed to have redis running localhost because
it is going to measure it's CPU usage stats.

All workers during benchmark test will have their dedicated CPU affinity
to make sure collected stats as accurate as possible.

~~~bash
git clone git@github.com:Mikhus/core.git
cd imq
node benchmark -c 4 -m 10000
~~~

Other possible benchmark options:

~~~
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
~~~

Number of child workers running message queues are limited to a max number
of CPU in the system -2. First one, which is CPU0 is reserved for OS tasks and
for stats collector process. Second, which is CPU1 is dedicated to redis
process running on a local machine, All others are safe to run queue workers.

For example, if there is 8 cores on a machine it is safe to run up to 6 workers.
For 4-core machine this number is limited to 2.
If there is less cores results will not give good visibility of load.

*NOTE: paragraphs above this note are Linux-only related! On MacOS 
there is no good way to set process affinity to a CPU core, Windows support is
not tested and is missing for the moment in benchmarking. I does not mean
benchmark will not work on Mac & Win but the results won't be accurate and
predictable.*

## Running Unit Tests

~~~bash
git clone git@github.com:imqueue/core.git
cd imq
npm test
~~~

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](LICENSE)
