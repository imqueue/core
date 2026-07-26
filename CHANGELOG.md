# Changelog

Notable changes to `@imqueue/core`. Entries start with the first release whose
behavior changes needed a written record; earlier history is in the git log.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
