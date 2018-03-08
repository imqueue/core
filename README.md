# I Message Queue (imq)

Simple JSON-based messaging queue for inter service communication

# Requirements

Currently this module have only one available adapter which is Redis server
related. So redis-server > 3.8+ is required.

Further, more adapters will be added.

# Install

~~~bash
npm i --save imq
~~~

# Usage

~~~typescript
import IMQ, { IMessageQueue, IJson } from 'imq';

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
    await queueOne.send('QueueOne', { 'i am delayed by': delay }, delay);
})();
~~~

# Benchmarking

First of all make sure redis-server is running on the localhost. Current
version of benchmark supposed to have redis running localhost because
it is going to measure it's CPU usage stats.

All workers during benchmark test will have their dedicated CPU affinity
to make sure collected stats as accurate as possible.

~~~bash
git clone git@github.com:Mikhus/imq.git
cd imq
node benchmark -c 4 -m 10000
~~~

Here are all possible benchmark options:

~~~
node benchmark -h                                   
Options:
  --version                     Show version number                    [boolean]
  -h, --help                    Show help                              [boolean]
  -c, --children                Number of children test process to fork
  -d, --delay                   Number of milliseconds to delay message delivery
                                for delayed messages. By default delayed
                                messages is of and this argument is equal to 0.
  -m, --messages                number of messages to be sent by a child process
                                during test execution
  -z, --gzip                    use gzip for message encoding/decoding [boolean]
  -e, --example-message         Path to a file containing JSON of example
                                message to use during the tests
  -t, --message-multiply-times  Increase sample message data given number of
                                times
~~~

Number of child workers running message queues are limited to a max number
of CPU the system has -2. First one, which is CPU0 is reserved for OS tasks and
for stats collector process. Second, which is CPU1 is dedicated to redis
process running on a local machine, All others are safe to run queue workers.

For example, if there is 8 cores on a machine it is safe to run up to 6 workers.
For 4-core machine this number is limited to 2.
If there is less cores results will not give good visibility of load.

## Running Unit Tests

~~~bash
git clone git@github.com:Mikhus/imq.git
cd imq
npm test
~~~

## License

[ISC](https://github.com/Mikhus/imq/blob/master/LICENSE)
