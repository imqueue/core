# AGENTS.md — orientation for coding agents

This file is for AI coding agents (and humans who like density) working on
`@imqueue/core`. It captures how the codebase is built, tested and structured,
plus the invariants that are easy to get wrong. Read it before making changes.
For contribution *process/terms* see [CONTRIBUTING.md](./CONTRIBUTING.md); for
end-user docs see the [README](./README.md) and https://imqueue.org/.

## What this is

`@imqueue/core` is the foundation of the @imqueue framework: a fast,
JSON-message queue for inter-service communication, implemented over **Redis**.
It is the transport that [`@imqueue/rpc`](https://github.com/imqueue/rpc) builds
its typed RPC layer on top of. No timers, no polling — delivery is driven by
Redis blocking list moves and keyspace notifications.

## Toolchain & invariants (do not fight these)

- **ESM only**, `"type": "module"`. Use `import`, not `require()`. Import
  sibling modules with the **`.js`** extension (NodeNext resolves it to the
  `.ts` source), e.g. `import { RedisQueue } from './RedisQueue.js'`.
- **TypeScript, `module`/`moduleResolution: nodenext`**, `target: es2024`,
  `verbatimModuleSyntax: true`, `isolatedModules: true`, `strict: true`. Use
  `import type` / `import { type X }` for type-only imports.
- **Node ≥ 22.12.**
- **Single runtime dependency: `ioredis`.** Do not add heavyweight deps; this
  package is meant to stay small.
- **Lint/format:** `oxlint` + `oxfmt`. Run `npm run format` before committing;
  CI checks `npm run format:check`.
- Build **emits `.js`/`.d.ts`/`.js.map` next to sources**; these are
  **gitignored, not committed** (`build` runs `clean-compiled` first, so stale
  artifacts never linger). Never commit compiled output.
- `removeComments` is intentionally **`false`** — downstream tooling and
  `@imqueue/rpc` rely on doc-blocks surviving compilation. Keep it that way.

## Commands

```bash
npm install
npm run build          # clean-compiled + tsc (emits alongside sources)
npm test               # build + node:test over every test/**/*.spec.js
npm run lint           # oxlint
npm run format         # oxfmt (write)  |  npm run format:check (verify)
npm run test-coverage  # tests + experimental coverage summary
npm run test-lcov      # writes coverage/lcov.info
npm run benchmark      # message-throughput benchmark (see below)
```

Tests use the native `node:test` runner with
`--experimental-test-module-mocks` and preload `./test/mocks/index.js`;
timeout is 15s per test. Run a single spec after a build with
`node --experimental-test-module-mocks --import ./test/mocks/index.js --test test/src/RedisQueue.spec.js`.

## Layout

| Path | Role |
|---|---|
| `index.ts` | Public entry: default export `IMQ` (factory — `IMQ.create(name, opts)`) plus `export * from './src/index.js'` |
| `src/IMessageQueue.ts` | The `IMessageQueue` interface + options/types + the `'message'`/`'error'` event contract. The abstraction every adapter implements. |
| `src/RedisQueue.ts` | Single-Redis-instance queue implementation (the default). |
| `src/ClusteredRedisQueue.ts` | Round-robin queue across multiple Redis instances for horizontal scaling. |
| `src/ClusterManager.ts`, `src/UDPClusterManager.ts`, `src/UDPWorker.ts` | Cluster membership / worker coordination (UDP-based discovery). |
| `src/IMQMode.ts` | `IMQMode` enum (queue role/mode). |
| `src/redis.ts` | `ioredis` wiring / connection helpers. |
| `src/profile.ts` | Profiling helper used across the library. |
| `benchmark/**` | Throughput benchmark (CPU-affinity pinned). |
| `test/**` | `node:test` specs + `test/mocks/` preload. |

## Delivery model (behavioural invariants)

- **Two delivery modes**, selected by the `safeDelivery` option: *unreliable*
  (fast; a message is lost if a consumer grabs it and dies) and *safe/guaranteed*
  (1.5–2× slower; a grabbed-then-lost message is rescheduled). Safe delivery
  covers the **processing**, not only the hand-off: the worker key is held until
  the `message` listener is done, and **a listener says so by what it
  returns** — a returned promise keeps the message checked out until it
  settles, anything else releases it as the listener returns. Listeners are
  therefore invoked through `rawListeners()` rather than `emit()`, which
  discards return values. Safe delivery relies on Redis `LMOVE`/`BLMOVE` —
  **Redis 6.2+ is required.** Unreliable delivery uses `BRPOP` alone and works
  on 3.2+, so quote 6.2+ as the requirement unless the sentence is specifically
  about the unreliable mode.
- **No polling / no timers.** Delivery uses blocking Redis ops + keyspace
  notification events. This is why a lease is reclaimed by asking the broker who
  is still connected (`CLIENT LIST`, already read once per maintenance tick for
  the cleanup pass) rather than by renewing a deadline: a per-message heartbeat
  would be a timer, and would prove only that the event loop is free rather than
  that work is progressing. `safeDeliveryTtl` bounds processing on top of that,
  for the handler that wedges inside a process which is otherwise healthy. If
  Redis has the `CONFIG` command disabled (e.g. AWS ElastiCache), keyspace
  notifications must be enabled out of band:
  `notify-keyspace-events Ex`.
- **Keyspace-notification flags are merged, never overwritten.**
  `notify-keyspace-events` is server-global, so `watch()` reads the current
  value and appends only the missing `E`/`x` flags (`A` counts as covering
  `x`), skipping `CONFIG SET` when the config already suffices. Do not go back
  to setting a literal — that silently breaks other consumers of the same
  Redis.
- **Messages must be JSON-serializable** (`IJson`/`JsonObject`). Delayed
  delivery is supported via the send `delay` argument.
- Scaling the number of workers must **not** increase Redis traffic — preserve
  this property in any queue change. `ClusteredRedisQueue` balances round-robin
  across instances.
- Idle queues must consume no resources — do not introduce background intervals.

## Using this package correctly (for consumer-facing code an agent writes)

```typescript
import IMQ, { IMessageQueue, IJson } from '@imqueue/core';

const q: IMessageQueue = IMQ.create('MyQueue');   // default: RedisQueue
await q.start();
q.on('message', (msg: IJson, id: string, from: string) => { /* handle */ });
await q.send('OtherQueue', { hello: 'world' });    // JSON-serializable only
await q.send('MyQueue', { later: true }, 1000);    // delayed 1000ms
```

Prefer `@imqueue/rpc` for typed service-to-service calls; use `core` directly
only when you need raw queue semantics.

## License

GPL-3.0. Commercial licensing for closed-source products: https://imqueue.com/.
