# Security Policy

SlipScan handles bank credentials and financial data on users' own machines. Security reports are taken seriously and handled with priority.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: [GitHub private vulnerability reporting](https://github.com/vul-os/slipscan/security/advisories/new) on `vul-os/slipscan`.
- Alternatively, email **vulosorg@gmail.com** with `[slipscan security]` in the subject.

Include what you can: affected component (vault, an adapter, a connector, packs, server), reproduction steps, and impact as you understand it. You'll get an acknowledgement within **72 hours** and a status update at least every **14 days** until resolution. Please give us a reasonable window to ship a fix before public disclosure — we'll credit you in the release notes unless you'd rather stay anonymous.

## Scope

Especially interested in:

- **Credential vault** — any path that displays, exports, logs, or exfiltrates secret material; envelope-encryption or keychain-handling flaws ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)).
- **Bank adapters & mail connectors** — egress beyond the user-configured endpoint, credential mishandling ([docs/BANK-ADAPTERS.md](docs/BANK-ADAPTERS.md), [docs/EMAIL.md](docs/EMAIL.md)).
- **Pack verification** — signature bypass, malicious-pack impact beyond mis-categorisation ([docs/PACKS.md](docs/PACKS.md)).
- **Benchmark privacy** — deanonymisation of contributors, DP implementation flaws ([docs/BENCHMARKS.md](docs/BENCHMARKS.md)).
- **The mantra** — any undisclosed network call. The app promises zero default egress; a violation is a security bug, full stop.

Out of scope: vulnerabilities requiring an already-compromised user session (documented residual risk #1 in the threat model), and issues in third-party services the user configures (their bank, their LLM provider, Proton Bridge).

## Supported versions

Pre-1.0: only the latest release (and `main`) receives fixes.

## Threat model

The full design — key hierarchy, write-only vault semantics, attacker scenarios, and plainly stated residual risks — is in **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**. Read it first; it tells you where the interesting attack surface is.
