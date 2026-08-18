# Changelog

Notable changes to `@imqueue/core`. Entries start with the first release whose
behavior changes needed a written record; earlier history is in the git log.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
