# Changelog

Notable changes to `@imqueue/core`. Entries start with the first release whose
behavior changes needed a written record; earlier history is in the git log.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
