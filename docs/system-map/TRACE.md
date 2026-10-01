# How the system works

The interactive map traces the local runtime, its records, and execution checks. [SOURCE_INDEX.json](SOURCE_INDEX.json) binds the published source files and anchors. [PUBLICATION_BINDING.json](PUBLICATION_BINDING.json) records the ordinary-document refresh and any explicitly reviewed publication-source changes. The displayed revision is informational; the fingerprint identifies maintained bytes.

Private historical research and raw execution workspaces stay outside the public edition. [The evidence disclosure](../open-source/EVIDENCE.md) explains those omissions. The [repair checklist](../system-review/CHECKLIST.md) and [repair status](../../computer-use-runtime/docs/REPAIR_STATUS.md) track earlier results and limits. This documentation starts no runtime, store, model, desktop, or browser task.

The earlier repaired-source check passed 327 TypeScript tests and a Python suite of 87 cases with 18 Windows skips. Its V4 replay completed 2,100 tasks and 300 prediction cases, then activated seed 17 in a disposable store. A separate task and rollback passed. Those results retain their execution scope. [Public verification](../open-source/VERIFICATION.md) records new checks of the publication copy. No static refresh establishes general native learning or qualifies an untested OS.

## Entry and service lifetime

One coordinator owns the selected local Store. Startup creates the browser/native router, Runtime and selectors, recovers saved work and serves the authenticated API on loopback. A duplicate start verifies the existing owner instead of opening another coordinator. SDK and MCP clients call that same service.

The bearer token authenticates API access. Host/Origin checks and POST correlation/idempotency requirements remain separate from input permission. Custom stores now refuse the default store's legacy token fallback. The offline CLI retains each constructed resource before awaited startup and attempts all owned cleanup even after construction, recovery or selector failure.

The Vue console encodes opaque IDs in URL path segments. Responses and downloads must still match their client/connection, selected task and request generation when they return. A slow reply cannot replace the selected task's state.

Sources: [launcher](../../computer-use-runtime/src/service/launcher.ts#L18), [store/token configuration](../../computer-use-runtime/src/service/lifecycle.ts#L6), [offline cleanup](../../computer-use-runtime/src/cli.ts#L306), [console selection](../../computer-use-runtime/console/App.vue#L66).

## Task, run and request

A TaskContract freezes the goal, requester, host/session/target, arguments, effects, expected facts, unresolved requirements and budgets. A Run contains that contract with the same ID, then adds execution status, cursor, selected skill, pinned model, bindings and error. Store saves it in `runs.body`; there is no separate task table.

An HTTP request is a transport call. Submission records its idempotency mapping with the new run and submitted event. A matching retry returns the saved run; changed payload with the same key fails. Missing consequential input leaves the run awaiting input. These records are not projects or chats.

Sources: [contract schemas](../../computer-use-runtime/src/contracts/index.ts#L28), [run shape](../../computer-use-runtime/src/contracts/run.ts#L3), [submission](../../computer-use-runtime/src/runtime/index.ts#L290), [request deduplication](../../computer-use-runtime/src/storage/index.ts#L194).

## Follow one effect

Runtime serializes execution through one input lane. It checks saved cleanup barriers, prepares the approved environment, resolves the skill and pins dependency versions. Program expansion now retains a caller guard before child entry and a separate caller verification at return. Durable child and active ancestor counters charge attempted steps and retries. A refusal spends a step. A resumed wait does not spend that same step twice.

Each action gets a new ID bound to the observation, target, revision, frame, lease generation and deadline. Policy and the adapter check the relevant authority before input. The `dispatched` journal event records an attempted call, not proof of OS delivery.

The shared receipt classifier accepts only the exact run/action binding. Recovery requires `phase: rejected` and explicit `dispatched: false`. Omitted or contradictory non-delivery proof, malformed values and nonfinite timestamps/timings become typed uncertainty. A journal failure retains both the delivery and persistence errors. ACK remains separate from effect verification.

Post-effect FALSE evidence must match the current target and observation and remain unexpired. Runtime rechecks freshness after journal work before choosing recovery. Unknown or expired evidence cannot authorize an automatic effect retry. The desktop assistant's known no-delivery path consumes the old approval, releases input and proposes again for a new explicit approval.

Pause, cancellation, takeover and restart preserve interrupted delivery and cleanup obligations. Failed cleanup quarantines the same owned host/session within that Store. Return acknowledges owned cleanup; reconciliation examines actual effects. Neither turns an uncertain action into a blind replay. Task success still waits for cleanup.

Sources: [program entry and return](../../computer-use-runtime/src/runtime/program.ts#L28), [invocation budgets](../../computer-use-runtime/src/runtime/invocations.ts#L54), [delivery classifier](../../computer-use-runtime/src/contracts/delivery.ts#L17), [effect freshness](../../computer-use-runtime/src/runtime/effect-evidence.ts#L4), [desktop runner](../../computer-use-runtime/src/assistant/runner.ts#L148), [saved cleanup barrier](../../computer-use-runtime/src/runtime/index.ts#L87).

## Durable records and storage lifetime

SQLite uses WAL and application-enforced relationships. There are no SQL foreign keys for these product records. Content-addressed files live beside the database. SQL and filesystem changes are separate operations.

| Record | Relationship and lifetime |
|---|---|
| Run | Stores its contract, status, cursor, exact versions and durable invocation budgets. History remains after completion. |
| Event | Ordered by run; retains observations, action attempts, receipts, experience and control history. |
| Artifact | A SHA-256 filename identifies bytes. Ingestion and reads reject an existing corrupt blob. |
| Workspace | A per-task granted directory under the Store. It is not a project or a general file browser. |
| Demonstration | Has its own ID and references the source run and before/action/receipt/after artifacts. Corrections revoke trust. |
| Skill | Current ID entry plus immutable hash-addressed capsule versions. A run pins exact dependencies across rollback. |
| Model | Registration binds bytes, paths and qualification. Activation affects later runs; existing pins remain. |
| Audit terminal | Immutable signed cleanup/persistence receipt published last. It binds results, episode/head rows and seal. |

The SQL `leases` table is declared but unused for active Lease objects, which keep owner/generation/expiry in memory. Store ownership, native OS ownership and workspace operation leases have different purposes.

There is no automatic history expiry. Retention explicitly previews and applies deletion to eligible orphaned artifacts. Back up the complete stopped Store, including journals, artifacts and token, plus separately registered models and qualification directories. Moving qualification paths can require requalification.

Sources: [Store schema](../../computer-use-runtime/src/storage/index.ts#L61), [artifact ingestion](../../computer-use-runtime/src/storage/index.ts#L207), [recordings](../../computer-use-runtime/src/recorder/index.ts#L25), [skill versions](../../computer-use-runtime/src/skills/index.ts#L77), [retention](../../computer-use-runtime/src/tools/retention.ts#L62), [backup](../../computer-use-runtime/docs/RUNNING.md#L235).

## Workspaces, recording and reusable skills

Workspace operations now require `exclusiveRoot: true`. Each cooperating operation takes an in-process lane and an exclusive `.cur-workspace.lock` lease. Reads check the opened file's identity, link count and before/after metadata; Linux also checks the descriptor's actual path. The trusted caller must exclude noncooperating writers. This is not an OS sandbox for hostile processes.

Recorder uses aligned before/action/receipt/after experience. Verified successful runs can supply positive demonstrations. Failure or unknown corrections cannot manufacture success. Compilation turns varied sessions into parameterized drafts and typed subflows. Local tests of the exact candidate and dependency closure precede publication.

Migration preserves source bytes and imports a fresh quarantined skill. The shared skill validator rejects the whole IDs `.` and `..` before writing. URL normalization cannot address those IDs as opaque segments. Other odd IDs remain supported and the console encodes them. Empty IDs already fail the schema. Dataset sharing redacts private text/identity by default. Import checks integrity and assigns unknown labels. Foreign hashes and claimed positives do not confer local trust.

Sources: [workspace lease](../../computer-use-runtime/src/tools/workspace-lease.ts#L9), [opened-file checks](../../computer-use-runtime/src/tools/index.ts#L222), [demonstration compiler](../../computer-use-runtime/src/compiler/experience.ts#L29), [library compiler](../../computer-use-runtime/src/compiler/library.ts#L21), [skill admission](../../computer-use-runtime/src/skills/index.ts#L38), [skill bundle import](../../computer-use-runtime/src/skills/bundle.ts#L347), [dataset import](../../computer-use-runtime/src/recorder/bundle.ts#L224).

## Two model roles and qualification

Installed Ollama models propose contracts, desktop actions, drawings and artifact content. The service checks advertised local capabilities before sending private prompts or opted-in screenshots. The daemon remains trusted. Provider responses now stream through a 1 MiB metadata or 4 MiB output cap before UTF-8 decoding and JSON parsing. Cancellation remains active during body reads. Output still needs contract, policy and independent verifier checks.

The owned ONNX controller ranks eligible bounded skills using before pixels and production context. Deterministic masks limit eligibility. `Run.model` pins that controller or fixed policy; it is distinct from the selected Qwen planner model. Training alone does not register, qualify or activate a model.

Qualification validates full heldout rows and recomputes metrics. New followup audits close the owned Runtime, recheck protected/source bytes and persist immutable outcomes before publishing the signed terminal last. Import/activation rejects incomplete finalization. Three exact historical protocol/results/seal triples have a narrow compatibility route; ordinary model/source/metric checks still apply.

Controlled learning reports, the known same-history clarification miss and the competent macro's lower observation count remain historical measured limits. The current V4 replay and disposable-Store activation have separate execution and saved-review evidence. This map only links those records.

Training origin and fresh qualification stay separate. The public ten-file origin bundle contains a manifest, earlier result and seal, unchanged selection and six historical sources. One of three already reviewed digest tuples must bind the same selection, six sources, three selected-input aliases and all 22 selected artifacts. The resolver never executes historical code or substitutes it for current source. Its archive hash is a descriptive extraction citation; a separate independent peer opened that historical ZIP.

Preparation admits that origin before copying. The audit validates it before creating a Store, adapter or Controller. Fresh local fingerprints and signatures bind the local origin bytes and literal current executable source. Finalization may resolve only three exact hash-bound selected-input aliases. It cannot remap a current executable path. Import verifies current source, models, metrics, origin and terminal before opening the chosen Store. Explicit activation remains separate.

The completed 299-file audit measured all 2,100 task and 300 head cases, but activation exited 1 on original trainer provenance. That failed attempt stays unchanged. The source-300 provenance repair passed code and admission review, then completed a fresh replay using unchanged weights, cases and thresholds. Its [primary receipt](../open-source/EVIDENCE.md), [metric review](../open-source/EVIDENCE.md) and [whole-current peer](../open-source/EVIDENCE.md) retain exact source, origin, models, rows and signed finalization. A [separate public task and rollback](../open-source/EVIDENCE.md) has [saved-state review](../open-source/EVIDENCE.md). It uses a disposable Store and does not activate the user's service. Replaying exposed cases does not establish new-family or native generalization.

The [new family study](../open-source/EVIDENCE.md) completes all 900 scheduled episodes at the repaired 299-file source. Its separate saved-state review checks the rows, journals, PNGs and exact bootstrap calculation. Trained weights complete 185 of 300 tasks and make 142 designated choices. Initialized weights complete 75 tasks; the authored selector completes all 300. The unchanged per-seed 95% effect and selection gate fails.

The trained effect difference is 0.366667 against initialized weights, with a 95% paired interval of 0.283333 to 0.45. It is -0.383333 against the authored selector, with an interval of -0.436667 to -0.33. That limited benefit over initialization does not establish general transfer. Hand-authored role descriptors and public candidate masks remain inputs. All unseen-program forecasts are unavailable, no model activates, and 291 learned-arm costs remain unknown. The interrupted v1 exposed 154 partial rows before the fixed schedule repeated after a separate source repair.

Sources: [bounded provider parsing](../../computer-use-runtime/src/providers/transport.ts#L35), [local provider](../../computer-use-runtime/src/providers/index.ts#L12), [controller](../../computer-use-runtime/src/learner/index.ts#L16), [qualification rows](../../computer-use-runtime/src/learner/qualification.ts#L44), [origin admission](../../computer-use-runtime/src/learner/portable-inputs.ts#L143), [prepare and install](../../computer-use-runtime/src/learner/requalification.ts#L44), [audit preflight](../../computer-use-runtime/evaluation/learning-followup-v4-audit.ts#L195), [audit finalization](../../computer-use-runtime/src/learner/finalization.ts#L133), [terminal verification](../../computer-use-runtime/src/learner/finalization.ts#L234).

## Hosts and evidence boundaries

DesktopRouter selects the owned browser, approved computer/window target or task workspace. The app launcher uses fixed definitions; a model cannot choose a shell command or executable path. Windows input uses a private native worker. Optional preferred Oculix capture needs exact native full-RGB/target validation. The normal service router disables that preference, and Oculix cannot authorize global input.

Linux portal consent grants devices and stream scope. Owner loss retains failed release obligations until acknowledged release or authoritative session closure. Static cached pixels can be displayed but cannot authorize current pixel input or visual completion. The supported coordinate profile remains narrow.

The portal parent passes a capture descriptor and stream node to a separate process. The original consent deadline also covers startup and the first frame. The guardian uses a Linux subreaper and pidfds to drain descendants and writes an identity-bound settlement receipt. A fresh graceful close needs its reply and completed guardian outcome. Timeout or missing settlement remains failure.

The [saved Linux 20 addendum](../open-source/EVIDENCE.md) records the actual earlier 299-file result and its separate independent review. All 20 original assertions pass on one private Mutter 43.8 fullscreen 1280 by 900 virtual monitor at scale 1. It includes real consent, source-timestamped PipeWire PNG, cached-pixel rejection, GTK effects, cancellation and loss. Its execution files remain unchanged at the current source. The 51 focused process/protocol checks use doubles and remain a separate test layer. Earlier environment and transport failures remain saved.

The exact owned container stopped within its bound with exit 137 and no wrapper cleanup errors. That is forced container settlement, not graceful native/container finalization. Parent-EOF worker exit 0 and independent GTK key/pointer releases are separate measurements. The intentional final PipeWire PID 81 stop precedes its manager-loss record. This profile does not establish physical displays, arbitrary Wayland mappings, Mac execution or Linux model quality.

Mac code exists without live Mac qualification. Physical mixed-DPI qualification remains failed. The current 300-file method has independent whole-method review and twelve filesystem checks, but is UNRUN. All 24 profile/effect assertions and the 90-second effects/120-second restoration limits remain unchanged. No preparation authorizes control of an unowned Settings window. The frozen 61-of-63 aggregate and tested ZIP belong to the historical 273-file source, not these repaired bytes. Objective verification, semantic opinion, explicit user confirmation, protocol doubles and live app effects remain different evidence.

Subprocess cleanup now uses Windows Job Objects or a Linux subreaper. Those supervisor limits do not imply a new Mac result. Isolated installation copies three exact historical terminal compatibility fixtures plus 22 selected artifacts and ten public origin members without importing a private key or Store. Packaging preserves the ten-member origin allowlist byte for byte and excludes unlisted origin files. New packaging uses a unique timestamp/source-bound output instead of overwriting the old ZIP. The exact new source-300 archive passed byte/CRC/privacy inspection and all seven commands outside Git, including setup twice. Its independent saved review is linked in the final evidence record. Fresh node_modules used installed Node/Python dependencies and Chromium cache. This does not qualify bare-OS provisioning. The original 273-file ZIP remains unchanged.

Sources: [router](../../computer-use-runtime/src/adapters/desktop.ts#L73), [Unix portal](../../computer-use-runtime/native/unix/portal.py#L185), [capture guardian](../../computer-use-runtime/native/unix/capture_worker.py#L350), [capture close](../../computer-use-runtime/native/unix/capture_worker.py#L243), [supervisor](../../computer-use-runtime/scripts/process_supervisor.py#L223), [isolated install fixtures](../../computer-use-runtime/scripts/clean-install.py#L21), [unique package output](../../computer-use-runtime/scripts/package.py#L2).

## Concepts absent from this checkout

There are no implemented account signup, billing, guest-pass, hosted upload, product-chat, project CRUD or Convex flows. Bearer auth is not signup. Provider `/api/chat` transport is not a saved conversation. A task workspace is not a project.

The [original search receipt](../open-source/EVIDENCE.md) retains the search and old source inventory. The [successor binding](../open-source/EVIDENCE.md) records exact unchanged service/contract routes and new repair reads. It does not invent a SaaS backend or treat nearby names as equivalent features.
