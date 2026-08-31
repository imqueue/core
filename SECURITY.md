# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in **@imqueue/core** (or any
`@imqueue/*` package), please report it **privately** — do not open a public issue,
pull request, or discussion for it.

Two private channels:

- **GitHub** — use *Security → Report a vulnerability* on this repository to open a
  private advisory (preferred; it keeps the report and the fix coordinated in one
  place).
- **Email** — <support@imqueue.com> with the details below.

Please include:

- the affected package and version(s);
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept, where possible.

## What to expect

- We aim to acknowledge a report within a few business days.
- We'll confirm the issue, keep you updated on progress, and coordinate a fix and a
  disclosure timeline with you.
- Once a fix is released we'll credit the reporter in the advisory unless you prefer
  to remain anonymous.

## Supported versions

Security fixes land on the latest published release line of each `@imqueue/*`
package on npm. Please make sure you can reproduce an issue against the current
release before reporting.

## Scope

The `@imqueue` framework is open source under GPL-3.0. This policy covers the code
in the `@imqueue/*` packages. Vulnerabilities in third-party dependencies should be
reported to those projects, though we're glad to help coordinate an upgrade.

## Transport security

Connections to the redis broker are plaintext unless you ask for TLS. Set the
`tls` option, or the `IMQ_REDIS_TLS*` environment variables, to encrypt every
connection a queue opens — see the TLS section of the README. When TLS is
configured there is no downgrade path: a broker that will not complete the
handshake is reported as a connection failure rather than reached in the clear.

Two limits are worth stating plainly:

- `UDPClusterManager` announces cluster membership over unauthenticated UDP
  broadcast. The announcements are neither encrypted nor signed, and the `tls`
  option does not apply to them.

  It does, however, bound what a forged announcement can achieve. Because
  brokers are announced by address, verification must be pinned to a name
  (`servername`) rather than left to compare against the address; a forged
  announcement then points a service at a host that cannot present a
  certificate signed by your authority, so it fails to connect rather than
  receiving traffic. Treat that as reducing an interception risk to a
  denial-of-service one, not as authenticating discovery.
- `rejectUnauthorized: false` leaves a connection encrypted but unauthenticated,
  and therefore open to interception. The queue warns when it is set. Supply the
  `ca` for your private authority instead.
- TLS material is read once, when the queue is constructed. A certificate
  rotated in place is not picked up by a running process, so rotation needs a
  restart — see the README for the CA-overlap procedure.
