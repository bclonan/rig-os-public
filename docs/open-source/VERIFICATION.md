# Verification and release scope

The October 1, 2026 public-source development checks pass. The reviewed application is suitable for an experimental local automation release. Several platform and research requirements remain open, so it should not be described as a fully qualified autonomous desktop agent.

The [fresh quality receipt](verification.json) records the exact maintained file hashes before and after execution. Its source fingerprint is `4519517387a35a5706f3024966ebbf2615ba3d25b6194cc9b9cec9210138fdeb`, across 300 maintained files. The files stayed unchanged during these checks. This receipt belongs to the portable public copy. Setup succeeded twice with fresh npm installs and the existing Chromium cache. The full quality check ran after setup finished.

## Fresh results

| Check | Result | What ran |
|---|---|---|
| `npm run check` | Pass | TypeScript and Vue type checks, Prettier, 327 passing TypeScript tests, TypeScript build and production console build |
| `npm run verify:audit` | Pass | Saved-byte consistency of the explicitly documented public audit derivative |
| `npm audit --audit-level=high` | Pass | npm reported zero vulnerabilities in the locked dependency tree at review time |
| Rust formatting | Pass | `cargo fmt --manifest-path native/Cargo.toml -- --check` |
| Rust linting | Pass | `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings` on Windows |
| Git whitespace | Pass | `git diff --check -- .` in the runtime package |
| Python syntax | Pass | 61 Python files compiled |
| Python tests | Pass with platform skips | 87 cases ran, 69 passed and 18 skipped on Windows |
| Console workflows | Pass | 11 checks using real Vue, Fastify, SQLite, Chromium and the existing ONNX models |
| Public exporter and normalization | Pass with host limits | 19 disposable cases ran, 17 passed and two real symlink-creation cases skipped because Windows denied creation |

The console [workflow report](console-verification.json) and [command receipt](console-command.json) are separate from the quality receipt. The check submitted and recorded three browser tasks, compiled the recordings, ran three candidate variations, published the skill, exported its exact hash and restored a previous skill version. It also exercised incorrect-token recovery, takeover and return, model activation and rollback, recording corrections, evidence replay and a 390-pixel layout. All six browser tasks succeeded. The browser reported no page errors.

The console run used a temporary store. It did not activate a model in the user's store. It did not run a local text or vision model, train new weights, send native desktop input or test another operating system. The word `native` in its required-field check refers to HTML form validation.

Quality checks used Node 24.17.0, Python 3.14.6 and Cargo 1.96.0 on Windows. `CUR_DATA` and `CUR_TOKEN_FILE` pointed to a disposable directory. The user's `.data/service` store was not used. The runner retained command exits, timeouts and cleanup errors. No command timed out or reported a cleanup error.

The [exporter receipt](export-verification.json) covers excluded secrets and database sidecars, unchanged copied source, existing-destination protection, source containment and refusal of private documentation metadata. Deterministic protocol checks exercise junction and symlink rejection. Actual symlink creation could not run on this host. The preparation flag produces private unreviewed staging. That staging still needs portable metadata conversion and a fresh scan before publication.

## What this review establishes

The project has working behavior beyond a static demonstration. The execution core serializes task execution and binds actions to the requester, task, host, session, target, observation, coordinate frame, deadline and input lease. [Policy](../../computer-use-runtime/src/runtime/policy.ts) enforces those checks outside model output.

[Delivery classification](../../computer-use-runtime/src/contracts/delivery.ts) distinguishes an acknowledged action from a proven rejection before dispatch. Missing or contradictory delivery evidence requires reconciliation. [The runtime](../../computer-use-runtime/src/runtime/index.ts) persists dispatch intent, checks fresh completion evidence and requires cleanup before recording verified success. Regression tests cover stale observations, interruption, pinned skill versions, caller and child budgets, uncertain input and failed cleanup.

[The service](../../computer-use-runtime/src/service/index.ts) checks Host, Origin, bearer credentials, correlation headers and idempotency keys. The reviewed console and SDK tests exercise the same public handlers. This is a single-user loopback service. It has no account registration, subscriptions, payment system, guest passes or Convex backend.

[Provider transport](../../computer-use-runtime/src/providers/transport.ts) rejects non-loopback addresses, credentials in endpoints, redirects, oversized responses and advertised cloud-backed Ollama models. A trusted generic compatible daemon can still forward requests elsewhere. Its loopback address alone cannot prove privacy.

[Model registration and activation](../../computer-use-runtime/src/learner/index.ts) preserve model hashes and require matching qualification. Training produces candidates. It does not automatically activate them. Existing tasks keep their selected model. Human confirmation of a general desktop task remains distinct from independent skill verification.

I did not reproduce a new material execution defect in these reviewed boundaries. That is the result of this review and the listed checks, not a claim that the project has no bugs or that it has received an external security audit.

## Remaining requirements

| Requirement | Current limit |
|---|---|
| Live macOS operation | Not run on a Mac. Static and protocol tests cannot establish native Mac input or capture. |
| Physical mixed-DPI transfer | The historical qualification failed. Later preparation checks do not qualify physical displays. |
| External host integrations | The Lense and Agent-OS examples describe contracts. Their real host protocols were unavailable for integration tests. |
| Benchmark VM results | OSWorld and WindowsAgentArena VM runs remain blocked by missing benchmark infrastructure. No score is claimed. |
| General native learning | Browser fixture qualification does not establish learning across arbitrary desktop tasks. |
| Broader learned transfer | The saved family study measured 185 correct effects out of 300 for trained weights, 75 for initialized weights and 300 for the authored controller. The learned-transfer gate failed. This review did not rerun that study. |
| Arbitrary desktop task completion | A model answer asks for review. User confirmation records the user's decision. The application has no independent verifier for every possible free-form goal. |

Windows and controlled Linux native evidence exists from earlier executions. Its platform, source and test-profile limits remain in [the platform guide](../../computer-use-runtime/PLATFORMS.md) and [repair status](../../computer-use-runtime/docs/REPAIR_STATUS.md). A saved passing report does not become a fresh live test merely because development checks pass today.

## Code quality assessment

The core is useful for developers who need bounded, reviewable automation, execution records and reusable demonstrated workflows. The browser fixture is the easiest way to learn and verify that machinery without changing desktop documents. The owned controller is an inspectable research example with measured limits. General desktop planning is experimental and needs action review.

The main maintenance debt is file size and uneven Python style. At the reviewed source, the HTTP service has 835 lines, the coordinator has 1,266 lines, and the two main console files have 882 and 923 lines. Some training scripts compress several operations onto one line. Those choices make later changes harder to inspect. The tests cover real failures and state changes, which is a stronger basis for an alpha release than the size of the documentation alone.

Public instructions should lead with setup and one working journey. Put source fingerprints and historical acceptance details in verification records. Repeating long repair receipts in every introductory paragraph makes the project harder to understand.

## Reproduce these checks

Run these commands from the repository root after installing the runtime dependencies:

```sh
python docs/open-source/run-verification.py
python docs/open-source/run-console-verification.py
python -m unittest discover -s docs/open-source -p "test_*.py"
```

Use `python3` on Unix when needed. The console check needs a built console, Playwright Chromium and the controlled model/evidence files. Its wrapper reads the maintained evaluation and changes only import locations and output destinations in a temporary copy. It disables real training. The command receipt records the original evaluation hash.

The screenshots from a local console check can contain the machine's hostname. Keep them local unless reviewed for publication. The JSON workflow receipt contains controlled fixture run IDs and check outcomes.

Before publishing a sanitized copy, run the checks there after its final code changes. Use a fresh clone to verify the documented installation. Preserve the failed and unrun capability labels in public documentation.
