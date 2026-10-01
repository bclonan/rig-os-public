# Code standards

These rules are mandatory for maintained code. Generated schemas, sealed evidence, model binaries and vendored dependencies are excluded from mechanical edits.

## Automated rules

Run `npm run check` before delivery. Prettier owns TypeScript, Vue, CSS, HTML and configuration formatting. TypeScript strict checking, unused-symbol checking and switch fallthrough checking cover source, scripts, examples, evaluations and tests. `vue-tsc` checks Vue templates as well as script blocks. Rust uses rustfmt and clippy with warnings treated as errors. Python has syntax and worker regression checks through the test suite; a Python lint/format migration has not been performed.

The current checker pair is TypeScript 6.0.3 and vue-tsc 3.3.11. Upgrade them together after running the console type check. See [ADR 0003](adr/0003-template-checking.md).

## Types and boundaries

Use camelCase for functions and values, PascalCase for types and classes, and descriptive filenames. Define contracts in `src/contracts`, adapter behavior in `src/adapters`, execution in `src/runtime` and HTTP translation in `src/service`. UI code must use the public API. The execution core must not import an HTTP server, a concrete environment adapter or a model provider.

Validate untrusted input at entry. Prefer `unknown` to `any` for new boundaries, then narrow or use a registered schema. Existing legacy `any` uses remain in dynamic JSON and third-party interfaces; they are not an exemption from validation. Do not use a type assertion as a substitute for validating externally supplied data. Reject unknown schema versions and unexpected contract fields.

## State and asynchronous work

SQLite owns durable task, request, version, recording and job state. Change related records inside a synchronous transaction. Do not await inside a store transaction. The Runtime execution lane owns adapter preparation, fixture resets and dispatch. Read-only API handlers must not rebind an active target.

Pass cancellation to waits and model calls. Release listeners, timers, workers, streams and leases in cleanup paths. Do not retry an action after uncertain delivery. An idempotency key must refer to one payload; persist it with its task or response. Use bounded deadlines and output sizes. A test that waits must have a deadline.

## Security and evidence

Enforce permissions outside model output. Bind receipts to their action and run. Skill publication requires three successful journaled runs of the candidate's exact hash. Imported skills and datasets remain quarantined. A model statement or human confirmation must not become an independent positive training label.

Authenticate routed API handlers, including encoded URL aliases. Local model endpoints accept HTTP or HTTPS loopback addresses without credentials and reject redirects. Use subprocess argument arrays; do not build shell commands from user input. Use fixed app IDs for desktop launch.

Errors must identify the failed operation and a recovery action without exposing tokens or private observations. Log run, correlation and action IDs where they explain a failure. Keep detailed evidence in private stores or controlled evaluation artifacts.

## Changes and tests

Pin dependency versions and retain lockfiles. Explain material architecture changes in an ADR. Reproduce behavioral defects before fixing them when practical. Tests must exercise outcomes or boundaries, not repeat implementation statements. Separate fixture, native, model-backed, contract-only and unavailable integration evidence. Do not loosen a gate to produce a passing result. Update commands and evidence links when behavior changes.
