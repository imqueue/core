# Changelog

Notable changes to `@imqueue/core`. Entries start with the first release whose
behavior changes needed a written record; earlier history is in the git log.

A released version absent from this file changed no behavior — it was a
documentation, CI or packaging-only release. Every release that changed what the
queue does has an entry.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **TLS on connections to the redis broker.** A new `tls` option encrypts every
  connection a queue opens — reader, writer, watcher and subscription alike.
  Pass `true` for Node's defaults, or an object handed to `tls.connect()` as
  given, so a private CA (`ca`) and mutual TLS (`cert`/`key`) both work. The
  option was previously accepted by the type system and dropped on the way to
  the client, which meant the bus could not be encrypted at all.

  Cluster entries may carry their own `tls`, overriding the cluster-wide one
  for that server alone; an entry that omits it falls back to the top level.
  Per-entry `username` and `password` are still ignored, exactly as before —
  honouring them would change what an existing cluster authenticates with, and
  that has nothing to do with this feature.

  With `tls` left unset the environment is consulted — `IMQ_REDIS_TLS`,
  `IMQ_REDIS_TLS_CA_FILE`, `IMQ_REDIS_TLS_CERT_FILE`, `IMQ_REDIS_TLS_KEY_FILE`,
  `IMQ_REDIS_TLS_KEY_PASSPHRASE`, `IMQ_REDIS_TLS_SERVERNAME` and
  `IMQ_REDIS_TLS_REJECT_UNAUTHORIZED` — so a deployment can encrypt a fleet
  without a code change. Certificate files are read as the queue is
  constructed, and an unreadable one throws: an unmounted secret stops the
  process rather than leaving it talking to the broker in the clear. Passing
  `tls` explicitly always wins, `tls: false` included, and
  `rejectUnauthorized: false` is warned about because it leaves a connection
  encrypted but unauthenticated.

  This covers the queue's own connections. `UDPClusterManager` announcements
  remain unauthenticated UDP broadcast and are unaffected.

- **Integration specs covering TLS against a real broker**, in
  `test/integration/`, run by `npm run test-integration`. They stand up a
  throwaway TLS-only redis and assert what a mocked `ioredis` cannot: that the
  handshake completes and is verified, that a message crosses it, that the
  connection pool keeps differing TLS configurations apart, and that plaintext,
  an unverifiable certificate and a wrong server name are all refused rather
  than downgraded. They skip themselves, with a reason, wherever
  `redis-server` and `openssl` are not both available, so a checkout without
  redis still passes. `npm test` now globs `test/unit` and does not run them.

### Changed

- **Nothing changes for a queue that does not use TLS.** The option is absent
  from `options` unless it was configured, the connection pool key stays the
  plain `host:port`, the redis client is handed no `tls` option, and no new
  warning is emitted. The only added work on that path is one environment
  lookup per queue construction, about a microsecond, and nothing at all per
  message. This is covered by its own group of specs rather than left as a
  claim.

- **A connection failure no longer takes the process down during teardown.**
  This is a behaviour change for everyone, not only TLS users: a socket that
  reported a second failure after the one that closed it used to reach an
  `error` with no listener and terminate the process. Such a process now stays
  up, and the failure is still logged and emitted as it always was. Nothing
  that previously succeeded behaves differently; a crash becomes a log line.

- **Shared writer and watcher connections are now keyed by TLS configuration as
  well as by `host:port`.** These connections are shared per server within a
  process; queues reaching one server under different TLS configurations now get
  separate connections, so a queue that asked for encryption can never be handed
  a plaintext socket another queue opened first, nor the reverse. Configurations
  equal by value still share, and the public `redisKey` still reports the plain
  `host:port` address.

- **`safeDeliveryTtl` is now the longest a message may be worked on**, and its
  default moves from `5000` to `300000`. It used to be a hand-off recovery
  deadline, which meant it bounded nothing that mattered: the key was deleted at
  dispatch, so it never covered processing at all. It now bounds processing,
  which is the only thing that recovers a message from a worker that is alive,
  connected and serving other messages while one handler has wedged on this one.
  Liveness cannot see that case, and restarting an otherwise healthy process is
  not a recovery strategy.

  Set it to the longest a handler in this system can legitimately take, with
  headroom — a slow upstream is the usual reason for a large value, such as a
  data vendor with no job API or screen-scraping behind an HTTP call. Too low
  and a message is reclaimed from a worker still legitimately working on it.

  The default rose because the meaning changed: 5000 was a sane hand-off
  deadline and is a poor processing budget.

- **The maintenance sweep now runs on `watcherCheckDelay`** (5000 ms by
  default) rather than on `safeDeliveryTtl`. How long a message may be worked on
  and how often the watcher looks for abandoned ones are different questions,
  and tying them would make a crashed worker's message wait out a budget meant
  for a live one. `watcherCheckDelay` is therefore the worst-case latency for a
  crashed worker's message coming back; with the watcher check disabled the
  sweep falls back to `safeDeliveryTtl`.

- **The reader's blocking pop is half `safeDeliveryTtl` capped at 5000 ms.** A
  lease deadline is stamped before the pop that fills the key, so an uncapped
  wait would hand a message a sizeable part of its budget already spent. At the
  old defaults both of these resolve to exactly what they were.

- The safe-delivery changes above alter meanings and defaults only —
  `safeDelivery`, `safeDeliveryTtl` and `watcherCheckDelay` are the same three
  options they were.

### Fixed

- **A failed connection could crash the process as it was being torn down.**
  The redis client guards its socket with a one-shot `error` listener, which
  the failure that brings the connection down spends. A socket that goes on to
  report a second failure — a rejected TLS handshake is answered by an alert
  that arrives after the rejection itself — then reached a socket with nothing
  attached, and the unhandled `error` took the process with it. The queue now
  installs a durable listener on the socket when a connection first fails and
  again before teardown, and `destroyChannel` no longer strips the client's
  own `error` handler before writing its `QUIT`.

  Reachable without TLS in principle, but TLS is what makes it ordinary: a
  service started against a broker it cannot verify would reject `start()` and
  then die inside `destroy()` rather than reporting the misconfiguration.

- **`safeDelivery` lost a message when a worker died mid-handler.** It released
  the message's worker key the instant the message was dispatched to the
  `message` listener, so a worker killed while its handler was still running
  took that message with it and nothing brought it back — the option guaranteed
  the hand-off while its name and documentation promised guaranteed delivery.
  The key is now held until the listener has finished with the message.

  **A listener says it has finished by what it returns.** Return a promise and
  the message stays checked out until it settles; return anything else and it is
  released as the listener returns. Every registered listener is consulted, and
  the message is released once all the promises they returned have settled —
  settled, not fulfilled, because a handler that threw has still had its turn
  and re-delivering on a rejection would retry a poison message forever.

  Nothing needs changing to get this: a listener that already returns a promise
  — as `@imqueue/rpc` and `@imqueue/job` both do — is covered as it stands, and
  a synchronous listener behaves exactly as it did.

  A message that cannot be unpacked releases its lease rather than coming back
  on every sweep.

- **A dead worker's message is recovered by asking the broker, not a clock.**
  The worker key now carries the identity of the process that took it, and the
  watcher reclaims it once that process has left `CLIENT LIST` — detected as
  fast as the socket closes, and needing nothing renewed to keep a live lease
  alive. Reconnecting workers get one sweep of grace, mirroring what the cleanup
  pass already gave them, so a reconnect backoff does not cost a duplicate. If
  the client list cannot be read at all, liveness is unknown and a lease is left
  to its budget rather than guessed at.

### Keeping the old behaviour

Release-at-dispatch is still available per listener, and exactly: **do not
return the handler's promise.**

```typescript
// held until the handler finishes — the fix
queue.on('message', async message => { await handle(message); });

// released at dispatch, bit-for-bit the old behaviour
queue.on('message', message => { void handle(message); });
```

Note that `safeDeliveryTtl` is not the lever for this. It never bounded a
dispatched message's lifetime before — the key was already deleted — and it does
not bound one now, so no value of it reproduces the old behaviour.

### Notes for upgrading

- A synchronous listener needs no change.
- A listener returning a promise now holds its message for the life of that
  promise, bounded by `safeDeliveryTtl`. Check that budget is above your slowest
  handler, since the default of five minutes is a guess about your workload and
  nothing else.
- Messages that used to vanish when a worker died now come back, so a handler
  that was quietly getting away with not being idempotent will start seeing
  repeats. Delivery was documented as at-least-once throughout; this makes the
  implementation match.
- Worker keys written by 3.x carry no owner and are still honoured by their
  deadline, so a rolling upgrade does not strand them. New keys put the owner
  *before* the deadline, so a 3.x watcher still reads the queue off the front
  and a number off the end rather than parsing garbage. While a 3.x watcher is
  the elected one it will still reclaim 4.x leases on that deadline, so expect
  duplicates for the length of the upgrade and finish it promptly.
- No new redis traffic and no new timers: the maintenance tick already read
  `CLIENT LIST` for the cleanup pass and lease recovery shares that one read.
  Nothing is renewed, polled or scheduled per message — a heartbeat would prove
  only that the event loop is free, not that work is progressing, and so would
  reclaim exactly when a worker is busiest.

## [3.4.0] - 2026-08-20

### Added

- **Silent failures of the transport are now reported without `verbose`.** Every
  line below is written through the configured logger, carries the queue,
  channel or host it is about and never the message payload, the arguments, a
  redis key or an error text. Nothing is scheduled and no timer is added.

  - A write to redis rejected inside `send()` — the caller already holds the
    message id and gets no rejection, so this was observable only through the
    optional `errorHandler`, which most callers do not pass. Reported as a
    failure episode per queue instance: the first rejected write is logged
    with its operation, message id and code, further rejections are only
    counted, and the first successful write logs the recovery together with
    that count. A failure a redis client delivers twice — through both its
    command callback and its returned promise — is counted once, while
    `errorHandler` keeps being invoked per delivery, exactly as before.
  - Safe reading of a queue ending on anything other than a planned stop,
    reconnect or destroy. A planned stop stays quiet, as before.
  - A failure of the periodic watcher-existence check itself; the failures of
    delayed-message processing and of watcher initialization were already
    logged and are not duplicated.
  - A subscription being established and being restored after a reconnect, and
    a failed reconnection attempt — the absence of the restore line after a
    reconnect is what makes a lost subscription provable.
  - Safe-delivery maintenance disabling itself for good when the writer
    connection is gone.
  - Messages of expired worker leases being re-queued — aggregated per
    processing pass into one line per destination queue with a count — and a
    worker key that could not be deleted: the two causes of a duplicate
    delivery.
  - Keys removed by the built-in cleanup, with the number of candidates and the
    number actually deleted.
  - A publish whose channel has no subscribers, on entering that state, and, in
    a clustered queue, a publish with no server to publish to at all.
  - In a clustered queue: round-robin having no available instance left, and a
    joining server failing to start or to subscribe, with the host and the
    phase.

  No control flow, return value, redis round-trip or timer was altered, and no
  new public API was added. One deliberate difference: the line reporting a
  worker key that could not be deleted is now written through a contained
  writer, so a logger which itself throws can no longer surface that throw as
  an unhandled rejection — every line of this change is required to be unable
  to influence queue behaviour.

  A failure code is never taken from the error as it is: only an allow-listed
  code is printed — an `IMQ_`-prefixed framework code, a system `E…` code, a
  small integer, a known redis reply code (`WRONGTYPE`, `NOSCRIPT`,
  `LOADING`, …) or one of a few known redis-client failure messages mapped to
  codes of our own. Everything else, including the error's message, stack and
  class name, is reported as `unknown`.

## [3.3.3] - 2026-08-18

### Fixed

- **Starting a queue overwrote the redis keyspace-notification configuration.**
  `notify-keyspace-events` is a server-global setting, and the watcher owner set
  it to the literal `Ex` on every connection establishment. Any other flag —
  enabled by an operator through a config file or by other code sharing the same
  redis — was silently dropped, breaking every consumer that relied on it, and
  coming back after each reconnect.

  The current value is now read first, only the missing `E`/`x` flags are
  appended, and `CONFIG SET` is skipped entirely when the configuration already
  suffices. `A` is recognised as covering `x`, so a server on `AK` only gains
  `E`. When `CONFIG` is unavailable (e.g. AWS ElastiCache) the read fails and
  the configuration is left untouched — enable `notify-keyspace-events` out of
  band there, as before.

## [3.3.0] - 2026-07-28

### Fixed

- **One transient sweep failure permanently disabled safe-delivery lease
  recovery and the cleanup sweep.** `processWatch()` cleared `safeCheckInterval`
  in its catch block, while `watch()` re-arms that interval only once per
  watcher connection, guarded by a `__ready__` flag the teardown did not reset.
  A single network blip, `CLUSTERDOWN` or slow failover therefore disabled both
  for that connection's whole lifetime.

  Nothing looked broken when it happened: the queue kept accepting and
  delivering messages, and only messages abandoned by dead workers quietly
  stopped coming back. Recovery needed the watcher connection replaced, or
  another instance winning the lock.

  A failed sweep now abandons only that sweep, and the next tick retries. The
  legitimate teardowns are unchanged — `runSafeCheck()` still clears the
  interval when the writer is gone, and `destroy()` clears it on shutdown.

- **The `./debug` export subpath could never resolve.** It pointed at
  `./debug.d.ts` and `./debug.js`, neither of which exists in the repository or
  in any published tarball, and nothing in core, rpc or the website imports it.
  Removed. Not a breaking change: resolving it failed before with
  `MODULE_NOT_FOUND` and fails now with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so
  nothing that worked stops working — only the error code differs.

### Deprecated

- **`IMessage.delay` and `IMQOptions.verboseExtended` are inert, and now say
  so.** `send()` builds the wire packet as `{ id, message, from }` and
  `process()` reads back the same three, so `IMessage.delay` is never written
  and never read — a delay lives in the delayed sorted set, not in the envelope.
  Nothing anywhere reads `IMQOptions.verboseExtended`, so setting it produces no
  extra output at all, though the published reference claimed it enabled
  extended verbose logging.

  Deprecated rather than removed because removal is type-level breaking, and
  inconsistently so: an inline object literal at the call site would stop
  compiling while the same option in an inferred config variable would not, so
  two users with identical intent would get different outcomes from one update.
  Both go in the next major.

## [3.2.4] - 2026-07-26

### Fixed

- **A destroyed queue could swallow one message addressed to the next owner of
  its queue name.** The reader is the only channel issuing blocking reads
  (`BRPOP`/`BLMOVE` with an infinite timeout), and redis cannot process a `QUIT`
  while one is in flight. The graceful quit therefore never completed, and the
  connection stayed a *registered consumer* of the queue until the
  `IMQ_CONNECTION_QUIT_TIMEOUT` grace period expired — outliving `destroy()`.
  Any message pushed to that key in the meantime went to the dead reader, whose
  read loop was already torn down, and was dropped with no error anywhere.

  The reader is now disconnected immediately, which unregisters it as a consumer
  without consuming anything. Idle channels are still quit gracefully, with the
  same forced-disconnect fallback as before.

  This is reachable whenever a queue name is handed over, which is exactly what
  `@imqueue/rpc` does when a client is destroyed and a new one takes its
  identifier — including from another process, where nothing on the rpc side can
  prevent it.
