import * as mock from 'mock-require';

export class RedisClientMock {
    set(...args: any[]) {}
    setnx(...args: any[]) {}
    lpush(...args: any[]) {}
    brpop(...args: any[]) {}
    on(...args: any[]) {}
    unref(...args: any[]) {}
    script(...args: any[]) {}
    client(...args: any[]) {}
    exists(...args: any[]) {}
    del(...args: any[]) {}
    zadd(...args: any[]) {}
    removeAllListeners(...args: any[]) {}
}

export class RedisMultiMock {}

mock('redis', {
    createClient() { return new RedisClientMock() },
    RedisClient: RedisClientMock,
    Multi: RedisMultiMock
});

export * from 'redis';
