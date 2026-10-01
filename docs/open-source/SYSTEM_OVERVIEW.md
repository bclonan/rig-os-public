# How rig-os works

rig-os runs on one local computer. The Vue console, HTTP clients, and MCP tools reach the same authenticated service. One coordinator owns a private SQLite store and serializes input. The model suggests work; the runtime and adapter decide whether input can run.

The [architecture canvas](../system-map/index.html) has 116 responsibilities, 180 relationships, 21 journeys, and 32 record explanations. It supports zoom, pan, search, and source inspection. The [written trace](../system-map/TRACE.md) follows execution checks in detail. The file index covers all 300 maintained files. Index coverage does not claim every line received a new manual review.

## The requested account and file flow

There is no signup, payment, guest-pass, Convex, cloud upload, or chat/project CRUD implementation. Entry starts a local service, reads or creates a token, and connects a browser client. The file-like flow accepts pasted data or an authorized public URL, creates a task workspace, and verifies JSON or CSV output.

| Requested concept | Actual code |
|---|---|
| Signup | A local bearer token grants access to a service store. There is no account database. |
| Payment or guest pass | No billing, entitlement, or guest-pass routes exist. |
| Convex | SQLite and local hashed files hold state. There is no Convex deployment or schema. |
| File upload | Artifact input is pasted JSON/CSV or a URL. Skill/dataset imports admit validated bundles. |
| Chat | Ollama's `/api/chat` is model transport, not a saved product conversation. |
| Project | A task workspace holds granted paths. There is no project record or membership. |

See [service routes](../../computer-use-runtime/src/service/index.ts), [store schema](../../computer-use-runtime/src/storage/index.ts), [artifact form](../../computer-use-runtime/console/ArtifactWorkspace.vue), and [providers](../../computer-use-runtime/src/providers/index.ts).

## Main components

| Component | Responsibility | Source |
|---|---|---|
| Console | Connect, submit, review, inspect tasks and models | [App.vue](../../computer-use-runtime/console/App.vue), [DesktopWorkspace.vue](../../computer-use-runtime/console/DesktopWorkspace.vue), [ArtifactWorkspace.vue](../../computer-use-runtime/console/ArtifactWorkspace.vue) |
| CLI and launcher | Own a store, start, recover, close workers | [cli.ts](../../computer-use-runtime/src/cli.ts), [launcher.ts](../../computer-use-runtime/src/service/launcher.ts), [lifecycle.ts](../../computer-use-runtime/src/service/lifecycle.ts) |
| HTTP API | Validate/authenticate requests, check host/origin, deduplicate | [service/index.ts](../../computer-use-runtime/src/service/index.ts) |
| Contracts | Bind goals to scope, effects, facts, and budgets | [contracts/index.ts](../../computer-use-runtime/src/contracts/index.ts), [run.ts](../../computer-use-runtime/src/contracts/run.ts) |
| Runtime | Execute, cancel, pin versions, journal, recover | [runtime/index.ts](../../computer-use-runtime/src/runtime/index.ts), [program.ts](../../computer-use-runtime/src/runtime/program.ts) |
| Policy and leases | Check permissions, target, ownership, freshness | [policy.ts](../../computer-use-runtime/src/runtime/policy.ts) |
| Planner | Request one bounded action and save it for review | [local.ts](../../computer-use-runtime/src/assistant/local.ts), [runner.ts](../../computer-use-runtime/src/assistant/runner.ts) |
| Providers | Call loopback models, deny redirects, cap output, validate | [providers/index.ts](../../computer-use-runtime/src/providers/index.ts), [transport.ts](../../computer-use-runtime/src/providers/transport.ts) |
| Router | Choose browser, native target, or granted workspace | [desktop.ts](../../computer-use-runtime/src/adapters/desktop.ts), [computer.ts](../../computer-use-runtime/src/adapters/computer.ts) |
| Native workers | Observe controls and perform capture/input | [Windows](../../computer-use-runtime/native/src/main.rs), [Unix](../../computer-use-runtime/native/unix/worker.py) |
| Browser fixture | Use isolated Playwright and check saved values | [browser.ts](../../computer-use-runtime/src/adapters/browser.ts) |
| Artifact tools | Grant paths, generate, recompute criteria, permit download | [artifacts.ts](../../computer-use-runtime/src/service/artifacts.ts), [artifact.ts](../../computer-use-runtime/src/assistant/artifact.ts), [workspace.ts](../../computer-use-runtime/src/adapters/workspace.ts) |
| Storage | Save runs/events and hashed artifacts, versions | [storage/index.ts](../../computer-use-runtime/src/storage/index.ts) |
| Recorder/compiler | Bind demonstrations, correct trust, create candidates | [recorder](../../computer-use-runtime/src/recorder/index.ts), [experience](../../computer-use-runtime/src/compiler/experience.ts), [library](../../computer-use-runtime/src/compiler/library.ts) |
| Skill registry | Validate, quarantine, publish tested versions, pin dependencies | [skills/index.ts](../../computer-use-runtime/src/skills/index.ts), [bundle.ts](../../computer-use-runtime/src/skills/bundle.ts) |
| Owned learner | Train, export ONNX, qualify, rank eligible skills | [learner](../../computer-use-runtime/src/learner/index.ts), [trainer](../../computer-use-runtime/learner/train.py), [qualification](../../computer-use-runtime/src/learner/qualification.ts) |
| Clients | Translate SDK and MCP calls to the same API | [TypeScript](../../computer-use-runtime/src/sdk/index.ts), [Python](../../computer-use-runtime/sdk/python/computer_use_runtime.py), [MCP](../../computer-use-runtime/src/service/mcp.ts) |

These boxes are responsibilities. Several share one process.

## Start and connect

1. CLI resolves the store and port.
2. Launcher acquires coordinator ownership, reads/creates the token, initializes adapters, and recovers saved runs.
3. Fastify serves the built console and API on loopback.
4. User pastes the token. The console keeps it in that tab's session storage.
5. Console discovers capabilities, windows, and local models.

A duplicate start checks the existing owner's identity. Custom stores have separate tokens. Shutdown pauses work and releases workers/ownership. Interrupted tasks need deliberate reconciliation.

## A reviewed desktop action

1. User submits a goal and computer or one-window scope.
2. API validates and saves a contract, run, and request-key mapping.
3. Runtime binds the target, captures an observation, and asks for a proposal.
4. Ollama receives controls and, only when opted in, a screenshot. Output passes schema checks.
5. Runner saves the proposal and waits for approval of its ID.
6. Runtime captures again. Target changes or expired evidence invalidate approval.
7. Policy/native checks verify permissions, target, frame, lease generation, and deadline.
8. Journal saves the attempt, receipt, and next observation. Ambiguous delivery requires reconciliation.
9. Model finish becomes `needs_review`. User confirmation becomes `completed_by_user`.

A receipt describes delivery, not success. A bounded skill checks specified effects before `succeeded`. Failed cleanup can block further input even after an app changed.

## An artifact task

1. User supplies data or URL, columns/calculations, and model.
2. API freezes the specification and creates a task/run.
3. Router creates a workspace with specific paths and allowed origin.
4. Skill reads source and asks the model to construct output.
5. Verifier recomputes values. Incorrect output triggers limited repair.
6. Successful verification permits preview/download of the same bytes.

Workspace grants and locks coordinate cooperating operations. Opened-file checks detect changes and link surprises. A trusted caller must exclude other writers. It is not an OS sandbox.

## Demonstration to reusable skill

Recorder aligns before observation, action, receipt, after observation, and effects. Verified runs can supply positive demonstrations. Corrections revoke trust. Compiler combines varied sessions into parameterized drafts and typed subflows.

Publication requires successful journaled tests of the exact candidate and resolved uncertainty. Runs pin skill/dependency hashes. Nested execution retains caller guards, child checks, return verification, and all active ancestor budgets. Rollback preserves existing version pins.

## Two model systems

| System | Input and output | Authority |
|---|---|---|
| Ollama model | Controls, optional screenshots, or source data. Proposes actions/plans/content. | Cannot approve itself, widen permissions, publish skills, or prove completion. |
| Owned PyTorch/ONNX controller | Bounded experience, pixels, production context. Ranks skills and exposes qualified predictions. | Deterministic masks restrict eligibility. Training, qualification, registration, activation are separate. |

`Run.model` pins the owned controller or fixed policy. The Qwen planner is separate. Qualification checks exact source/model/input bytes, metrics, and a signed terminal written after cleanup. Historical training origin stays separate from current executable source.

Browser studies establish measured behavior in their specified profile. The transfer study's trained controller lost to the authored controller. Native desktop learning remains open.

## Records and storage

| Record | Relationship |
|---|---|
| Task contract | Immutable goal, scope, effects, facts, budgets. Stored inside the run. |
| Run | Status, cursor, bindings, exact versions, errors. No separate task SQL table. |
| Event | Ordered run journal of observations, attempts, receipts, controls. |
| Request key | One payload digest maps to a run. Conflicting payload fails. |
| Artifact | SHA-256 identifies bytes. Corrupt content fails ingestion and reads. |
| Workspace | Per-task directory/grant metadata, not a product project. |
| Demonstration | Source run and aligned evidence. Corrections affect trust. |
| Skill version | Immutable capsule/dependency hashes. Active version affects later tasks. |
| Model registration | Binds files to qualification. Activation changes future selection. |

SQLite uses WAL. Application code enforces relationships without SQL foreign keys. The schema declares a `leases` table, but active input lease objects hold owner/generation/expiry in memory. Store ownership and workspace locks are separate mechanisms.

History has no automatic expiry. Retention previews eligible orphaned artifacts before deletion. Back up the stopped store plus model and qualification directories. Private stores contain screenshots, text, tokens, and history.

## Remaining gaps

Mac execution needs a Mac. Physical mixed-DPI qualification remains failed. External integration needs actual hosts or benchmark infrastructure. General native learning needs an independent native study. Controlled Linux virtual-monitor checks do not qualify arbitrary Wayland mappings or physical hardware.

The [repair status](../../computer-use-runtime/docs/REPAIR_STATUS.md) and [feature matrix](../../computer-use-runtime/docs/FEATURE_MATRIX.md) preserve these limits. Historical checks retain their source identities. Static architecture checks verify documentation, not desktop behavior or acceptance.
