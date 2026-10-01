You are the autonomous implementation engineer for a NEW, STANDALONE learning computer-use runtime.

BUILD THE SOFTWARE, not a proposal. Implement, execute, debug, train, evaluate, package, and document a working component that can be developed and tested independently, then plugged into Lense, Agent-OS, or another application through thin adapters.

MISSION

Deliver a lightweight LEARNING COMPUTER-USE RUNTIME THAT COMPILES EXPERIENCE INTO VERIFIED, REUSABLE SKILLS.

USE LEARNING TO DISCOVER, SELECT, AND IMPROVE PROGRAMS.
USE A DETERMINISTIC RUNTIME TO EXECUTE THOSE PROGRAMS UNDER VERIFIED CONDITIONS.

Our owned, trainable model learns which skill applies, what state the computer is in, what information is missing, and how to recover. Interchangeable larger models handle unfamiliar instructions, difficult visual judgments, research, and creative work, not every mouse movement.

The complete path is:
plain-language goal → explicit task contract → observed environment → learned skill selection or bounded plan generation → validated hierarchical machine → authorized host actions → independently assessed effects → recorded experience → compiled skills and trained candidates → regression testing → gated promotion.

1. STANDALONE MEANS STANDALONE

This instruction explicitly REPLACES earlier requirements to implement inside, repair, or preserve the internal architecture of bclonan/agenetic-os.

Create a new repository/package named computer-use-runtime, or an isolated directory with that name if the workspace contains unrelated files. Preserve unrelated work. Do not modify Lense or Agent-OS during this build.

The component must install, start, accept tasks, control an authorized environment, record demonstrations, compile skills, train its owned model, evaluate candidates, and export artifacts WITHOUT either host application present.

It owns its standalone execution state and storage. It must not import host application internals, depend on their databases, require their model routers, or wait for access to their repositories.

Lense and Agent-OS are future CLIENTS or ENVIRONMENT ADAPTERS. Provide contracts, SDKs, examples, and integration tests now. Actual host integration is a separate operation, not a prerequisite for core completion.

Build a component, not a replacement operating system, chat platform, SaaS product, or collection of competing agent frameworks. A minimal standalone control console is required for use and testing, but not an elaborate frontend.

2. ARCHITECTURE AND IMPLEMENTATION DEFAULTS

Use a modular monolith with a headless core, one durable coordinator, one skill registry, and one learning pipeline.

Default stack:
- TypeScript/Node for the public SDK, compiler, coordinator, and service.
- XState or a justified maintained statechart executor behind OUR portable contract.
- SQLite and a local content-addressed artifact directory for persistence.
- Rust for native host primitives and measured latency-sensitive work.
- Python/PyTorch for training; ONNX for lightweight deployed inference where compatible.
- A small Vue control console consuming the same public API as external clients.

Use compatible supported versions, pin dependencies, and document necessary substitutions. Do not implement an entire new statechart engine when a suitable library can supply execution semantics.

Provide clear modules for contracts, runtime, compiler, predicates, skills, adapters, providers, recorder, learner, evaluation, SDK, service, and console. Keep module boundaries enforceable through tests.

The headless library must work without the console or HTTP server. The standalone service wraps the SAME library. Support embedded or service deployment, but never two coordinators owning the same run. Do not require Redis, Kubernetes, a vector database, or a cloud service.

Define ports for EnvironmentAdapter, ModelProvider, EvidenceVerifier, SkillRepository, ExperienceStore, and PermissionPolicy. Keep platform, provider, storage, and UI dependencies outside the execution semantics.

3. PUBLIC CONTRACTS AND FUTURE INTEGRATION

Define versioned JSON schemas for TaskContract, Observation, Action, Receipt, PredicateEvidence, SkillCapsule, RunEvent, ProviderCapabilities, and ModelVersion. Generate or validate SDK types against these schemas.

Expose authenticated local HTTP plus an ordered reconnectable event stream and a TypeScript SDK. Supply a lightweight Python client for Python hosts. Add an MCP facade using the same handlers where practical.

Support task submission, status, observation, pause/resume/cancel, evidence retrieval, demonstration recording, skill import/export, compilation, training, evaluation, model activation, rollback, and capability discovery.

Each request includes correlation identifiers and idempotency handling where applicable. API request deduplication is NOT a promise of exactly-once GUI effects.

Persist transitions, receipts, bindings, evidence, and exact skill/model versions. Do not hold database locks across inference or desktop operations. Restart must reconcile interrupted actions before continuing. Browser disconnection must not terminate a task.

Supply runnable examples for:
- A generic client submitting a goal and watching events.
- A Lense-style TypeScript client and bridge adapter.
- An Agent-OS-style Python client and bridge adapter.
- A custom skill and a custom environment/provider plugin.

If actual host protocols are accessible, inspect them read-only and implement matching adapters. Otherwise define the mapping explicitly and label actual host compatibility UNVERIFIED. Do not invent existing endpoints.

When plugged in, the host submits goals and consumes evidence; this runtime owns the skill execution loop. A host bridge may provide capture/input, but no second agent may concurrently actuate that desktop outside the same ownership policy.

4. INTENT COMPILATION: EXPLICIT VERSUS IMPLICIT

Implement two passes:
A. Establish the requested outcome, constraints, authorized effects, parameters, defaults, and unresolved choices.
B. Select compatible methods and recursively establish their prerequisites.

Track requirement origin:
user_explicit, user_preference, method_precondition,
environment_observation, system_policy, chosen_default, unresolved.

Explicit/implicit is not the same distinction as deterministic/dynamic. A prerequisite of one implementation is not automatically a user requirement.

For “Open Paint and draw a dog”:
- Paint and a recognizable dog drawing are explicit.
- An editable canvas and correctly targeted input are prerequisites of the chosen drawing method.
- Breed/style may use recorded low-risk defaults.
- Saving, overwriting, uploading, and sending are not implied.
- Generating an image elsewhere and opening it in Paint is not equivalent to drawing with Paint unless the contract permits importing.

Separate immutable task parameters, run-specific bindings such as document identity, and transient observations such as coordinates/window handles.

Provide a deterministic path for supported structured contracts and a genuine local-model-assisted general-language compiler. Do not implement production natural language as a list of hardcoded demo phrases. Validate generated contracts before execution.

Resolve harmless unspecified details through documented defaults. For consequential ambiguity, gather evidence or enter an actionable awaiting-input state. Never silently expand permission scope. Accept unfamiliar goals without pretending they are supported; discover, delegate, or report the exact missing capability.

5. PORTABLE SKILLS AND EXPERIENCE COMPILATION

A SkillCapsule is a versioned portable package containing:
- Typed inputs/outputs and parameter bindings.
- Capability requirements, preconditions, expected effects, and permitted side effects.
- Hierarchical states, registered operations, guards, transitions, subskills, and event waits.
- Verification, recovery handlers, retry/deadline/resource budgets.
- Locator alternatives and environment compatibility scope.
- Dependencies, evidence provenance, tests, and immutable content/version hashes.

Use JSON as the executable representation; YAML may be an authoring form. Specify semantics independently of XState. Use registered predicates/actions and a bounded expression language, never eval of generated source or unrestricted shell snippets.

Implement hierarchy, composition, cancellation, durable waits, pause/resume, and parallel monitoring. Monitoring concurrency does not grant concurrent foreground input.

Use reusable operations such as obtain_document, select_tool, edit_content, and verify_result, not one enormous agent per application. Resolve controls against current observations rather than permanently memorizing coordinates.

Implement a REAL compiler:
multiple demonstrations → meaningful segmentation → related-run alignment → typed parameter extraction → repeated-subflow extraction → candidate guards/recovery → executable draft machine → variation/regression tests → publication.

Label hand-authored seed skills. At least one new parameterized skill must actually be compiled from multiple demonstrations and succeed with unseen inputs. A recording replay or a selector over only prewritten scripts does not satisfy compilation.

Do not infer causality or necessity from one successful trajectory. Test proposed preconditions through controlled variations. Keep uncertain abstractions in draft status.

Support inspectable import/export bundles, schema migrations, dependency validation, and quarantine for imported skills. Hash integrity does not establish correctness or permission to execute.

6. EVIDENCE-BACKED STATE AND RECOVERY

Predicates use TRUE, FALSE, or UNKNOWN. Include target scope, evidence references, time, freshness/invalidation rules, detector version, and calibrated confidence where applicable.

Distinguish operational facts, task-completion facts, application knowledge, and externally researched claims. “Request accepted,” “input dispatched,” “Paint open,” “canvas changed,” and “dog drawn” are different assertions.

Prefer objective application/accessibility checks, authorized artifact inspection, and independent controlled-task evaluators. A model's YES is an assessment, not automatically ground truth. Preserve semantic acceptance separately from objectively verified success. Unknown never passes a required guard.

Use dependency-based invalidation, native events, scoped region-change detection, and small visual classifiers. Recheck what changed rather than resending the entire screen/history to a large model. Do not save computation by skipping necessary verification.

For semantic content, inspect the relevant canvas/artifact. Test blank canvas, one line, wrong subject, text saying “dog,” incomplete content, and the requested subject outside the target canvas. The generating model's self-approval must not be the sole completion evidence.

Recovery must progress through fresh observation, a permitted low-risk probe, a known local repair, bounded replanning/escalation, then actionable blocked status. Do not guess blindly, spam Escape, halt at every minor uncertainty, or repeat entire tasks unnecessarily.

7. REAL HOST BRIDGES, OCULIX, AND UPSTREAM REUSE

Implement a working browser adapter and Windows native-host adapter. Exercise available Linux/VM support through the same contract. Unsupported platforms must advertise that fact, not silently map to another desktop.

Inspect https://github.com/oculix-org/Oculix and use it as the preferred visual-automation backend for operations its ACTUAL inspected interface supports. Verify current source, schemas, requirements, releases, and license; pin a version/commit.

Prefer its supported interface, including MCP where appropriate. Do not invent tool names or assume screenshot support implies clicks, drags, scrolling, or key holds. Use narrowly scoped native primitives behind the same contract for missing operations. Record the executing backend in every receipt.

Oculix/native input runs in the selected machine's INTERACTIVE DESKTOP SESSION, not accidentally inside an unrelated container or WSL desktop. Keep its transport private through stdio or authenticated loopback. Supervise startup, readiness, timeouts, cancellation, held-input cleanup, and shutdown.

Use supported application operations, accessibility/DOM targeting, visual anchors, and learned grounding according to the task's method constraints. Do not force reliable structured operations through pixel matching.

Inspect and selectively reuse compatible components/patterns from:
OpenAdaptAI/openadapt-flow; microsoft/UFO; bytedance/UI-TARS-desktop;
simular-ai/Agent-S; xlang-ai/OpenCUA; microsoft/OmniParser;
XState; Playwright; SikuliX/Oculix; Villavu/Simba and relevant SRL libraries;
Ineedajob/RSBot; open-rpa/openrpa; PrismarineJS/mineflayer-statemachine.

These are research candidates, not mandatory dependencies. Verify code/model/data licenses and exact versions. Record borrowed components, changes, and obligations in THIRD_PARTY.md. Do not combine every framework or import game-client injection, anti-cheat dependencies, or anti-ban behavior.

Profile before rewriting. Use Rust/C/C++ for demonstrated bottlenecks, not a speculative rewrite of all Oculix or orchestration code. Keep large-model inference out of the per-frame/per-pointer fast path.

8. INPUT OWNERSHIP, SAFETY, AND FAST EXECUTION

Every action binds requester, run/action ID, device/session, target identity, originating observation, coordinate frame, operation/arguments, deadline, and permission scope.

Handle DPI/scaling, crop offsets, window movement/resizing, multiple monitors, stale handles, and focus changes. Revalidate before input. Reject wrong-host, stale-target, and mismatched-observation actions. Reconnection must not silently switch hosts.

Enforce one foreground-input owner per desktop at the host boundary, including competing clients. Implement leases/generation checks, manual takeover, explicit return, pause, cancellation, emergency stop, and release of held keys/buttons. Separate desktops may execute concurrently.

Journal requested → authorized → dispatched → acknowledged → effect_verified.
After uncertain dispatch, observe and reconcile before deciding to retry. A failed follow-up capture must not repeat an already delivered input. Never claim universal rollback or exactly-once GUI effects.

Use bounded local action segments, event-driven waits, selective observations, and resident small-model inference. Preserve stop handling during segments. Measure capture, encoding, transport, inference, dispatch, verification, and end-to-end latency separately.

Default to local-only authenticated access and minimal capabilities. Local service tokens are generated locally; “no model API key” does not mean unauthenticated desktop control. Do not bypass OS consent, secure desktops, antivirus, or application permissions.

Generated skills, webpages, model output, and imported packages are untrusted. They cannot grant themselves authority. Optional shell/filesystem tools require separate scopes and must not be added implicitly to restricted bridge adapters.

9. OWNED MODEL AND TRAINABLE EXPERIENCE

Deliver actual model code, parameter updates, initialized/trained checkpoints, reload tests, and deployed inference. Prompt changes or a saved macro library alone do not satisfy learning.

Start with a small goal-conditioned GRU/Transformer controller and visual-state component sized for available hardware, initially aiming for <=10 million owned trainable parameters. Report any frozen pretrained encoder separately. Keep a CPU-runnable learning experiment; do not make basic operation depend on a GPU.

Inputs: structured goal, machine state, known/unknown predicates, candidate-skill descriptors, scoped visual features, recent actions/outcomes, and budgets.
Outputs: skill ranking, next observation/probe, recovery choice, predicted success/cost, wait, and escalation.

Score skill descriptors so newly compiled skills are not restricted to a permanently fixed list of output IDs. Apply deterministic permission/precondition masks outside the model. It cannot authorize actions or declare its own training reward.

Implement supervised skill selection, visual predicate learning with unknown-label masking, outcome/cost prediction, and correction aggregation from states the learner actually reaches. Use bounded reinforcement learning only where resettable environments and independent rewards support it.

Record synchronized request/contract, BEFORE observation, allowed structural data, action/coordinates, receipt, AFTER observation, independent labels, uncertainty, corrections, and environment/model/skill versions. Preserve usable image references, coordinate transforms, and timing. Text-only traces are not visual training data.

Prevent post-action information, hidden evaluator state, test answers, or future observations from entering policy inputs. Split by whole sessions/task families, not adjacent frames. Include failures, abstentions, interruptions, layout changes, and hard negatives. Redact secrets and enforce retention/access controls.

Provide recording, correction, dataset export/import, training, evaluation, activation, and rollback. Include a reproducible local fixture/dataset generator with separated training and evaluator interfaces. Label synthetic/controlled data honestly; it is not proof of general real-desktop ability.

Report seeds, losses, data splits, parameter count, checkpoint size, RAM, CPU inference latency, raw outcomes, and export parity. Deploy through ONNX where supported; any alternative needs tested loading/inference. A changed checksum or lower training loss alone does not prove improvement.

10. OPTIONAL MODELS, KEYLESS OPERATION, AND DISCOVERY

Implement a working Ollama adapter and generic local endpoint adapter. Optional supported authenticated Codex/Claude/client adapters may reuse official login mechanisms after checking their current documentation. No API-key requirement, credential scraping, undocumented subscription proxy, or silent paid/cloud fallback.

Providers advertise modalities, structured output, tool support, cancellation, locality/privacy, and resource limits. Do not send images to text-only models or equate a text response with image generation.

Prefer compatible installed models. If needed and feasible, bootstrap one appropriately sized ungated local model within recorded download/disk/RAM budgets, pinning identity and license. Missing access is a specific unavailable state, not simulated reasoning. The runtime must not depend on this Codex session as its hidden planner.

Use larger models only for bounded contracts: unfamiliar language interpretation, grounding, research, creative plans, or semantic assessment. Validate every result. For drawing, obtain a bounded stroke plan, validate it, and execute segments deterministically inside the verified canvas.

After dependency/model bootstrap, known-skill execution, owned-model inference, and local learning fixtures must work with network access disabled. Online research and remote messaging are separate network-dependent capabilities. General-language/semantic gates still require a real compatible provider; do not conceal its absence with hardcoded responses.

Implement uncertainty → targeted observation/research → candidate predicate/skill → controlled test → independent evaluation → promotion/rejection. Store source, retrieval time, application/version scope, claim, evidence, and validation status. Documentation does not prove a current effect.

Demonstrate a new predicate or workflow learned from documentation and observations in a resettable unfamiliar surface, without hand-coding its held-out solution after seeing the audit instance.

Keep skill accumulation, model-weight learning, and improvement-process learning separate. Provide bounded self-development hooks: isolated candidate/worktree, tests, runtime exercise, diff/evidence, gated activation, rollback. Never modify the running controller mid-task or let a candidate rewrite protected evaluators, permissions, or promotion criteria. Do not claim unbounded RSI.

11. STANDALONE USE, SETUP, AND PLUG-IN PACKAGING

Provide idempotent PowerShell and shell setup/start scripts, isolated supported runtimes, dependency/model diagnostics, and doctor output. Repeated setup must not duplicate workers. No Docker requirement for interactive Windows input; containers may host appropriate noninteractive components.

The console needs goal/target/provider selection, live observation, machine progress, predicate evidence, action history, recording/correction, skill inspection, model status, replay, training/evaluation controls, latency/call counts, pause/resume, cancel, and takeover.

Provide local UI and CLI operation without any host framework. Support explicitly authorized remote clients over authenticated transport without opening public ports automatically. Remote execution must target the host, not the submitting client.

An optional Telegram adapter/example may submit ordinary tasks through the API with configured credentials, deduplication, host authorization, status, and cancellation. Telegram credentials and Tailscale are not prerequisites for the standalone component. Do not build another orchestration loop inside these clients.

Package the core, service, native bridge, model artifacts, SDKs, and examples with clear dependency boundaries. Export skills/evidence using portable manifests rather than host-specific database rows. Document thin integration recipes and contract tests for Lense and Agent-OS; do not alter those applications during this assignment.

12. FREEZE THE EVALUATION BEFORE CLAIMING SUCCESS

Create acceptance.json and a frozen evaluation protocol before final tuning/audit. Separate PASS, FAIL, BLOCKED, NOT RUN, and UNVERIFIED. Record evidence level: unit/mock, adapter contract, resettable live fixture, native desktop, second-machine remote, or live Telegram.

Test these gates:

A. Clean standalone installation
Start in a clean isolated environment without Lense/Agent-OS. Exercise API/SDK/console, persistence, restart/reconciliation, schema rejection, offline core operation, and repeated setup. Confirm no host-internal imports or mandatory cloud credentials.

B. Real bridge readiness and direct input
Identify the actual host/session, discover pinned backend capabilities, capture a real screenshot, focus a disposable application, type a generated unique string, exercise supported pointer/drag/scroll/shortcut/hold operations, verify effects, and demonstrate stop/input cleanup.

C. End-to-end language tasks through the real planner/runtime
- Text editor: generated sentence, explicitly requested save, independent content check.
- Calculator: generated arithmetic and displayed-result check.
- Paint: prescribed shape, explicitly requested save, deterministic image check.
- Paint: “Open Paint and draw a dog,” with operational and semantic assessments kept separate; no invented permission to save/upload.
- Browser: a parameterized form/documentation workflow and an explicitly requested sourced output.
Do not secretly perform GUI-specified work through shell/file writes. Independent evaluators may inspect artifacts. A controlled browser canvas is not Microsoft Paint.

D. Reliability, compilation, and transfer
Test stale observations, wrong hosts, focus loss, layout/scaling changes, dialogs, provider/backend failure, ambiguous delivery, failed follow-up capture, restart, cancellation, duplicate requests, manual takeover, malicious instruction text, and false completion.
Compile a parameterized skill from multiple demonstrations, run unseen inputs, compose held-out tasks, discover a new predicate/workflow, and test skill/model rollback. Failed/uncertain runs must not become verified positive labels.

E. Actual learning and efficiency
Use at least three training seeds and a meaningful paired held-out resettable suite. Default to at least 100 held-out fixture episodes per method per seed, including unseen compositions; native smoke tests are a separate smaller suite. Freeze exact counts, budgets, splits, baselines, metrics, and resource-based adjustments BEFORE the audit.
Compare trained versus initialized controller, a competent fixed selector, and the system without learned compilation. Hold the library fixed to isolate weight learning; hold the controller fixed to isolate library growth. Match available observations/tools/budgets and include abstentions/failures.
Measure task success, false success, recovery, interventions, observations, large-model calls, inference/end-to-end latency, and training/compilation cost. Report all seeds and uncertainty intervals.
Predeclare a benefit criterion: better held-out success OR lower observation/execution cost without meaningful correctness regression. Specify the noninferiority margin before evaluation. Never tune on sealed audit outcomes or weaken gates to create a pass.
Known navigation must run without generative-model action selection; count creative work and semantic checking separately. If the learned controller fails, retain the competent fallback and mark the learning-benefit gate FAIL, not the entire usable runtime as successful learning.

F. Integration readiness, benchmarks, and real time
Run example-client and host-adapter contract tests without importing either host application. Keep actual host integration UNVERIFIED until exercised there.
Inspect pinned WindowsAgentArena and OSWorld custom-agent interfaces and implement narrow adapters around this SAME policy/runtime. Do not leak evaluator state or bypass benchmark action accounting. Run available small smoke sets; report missing infrastructure and never call smoke tests a full score.
Test a controlled moving-target/game fixture with real observation/action timing, stale-frame handling, cancellation, and held-input cleanup. Do not claim real-time capability from screenshots alone.
Test second-machine remote and live Telegram only when available, after matching local host readiness passes. Local HTTP/mocked messaging are not live remote evidence.

Recorded screenshots can test perception, not the outcome of alternative actions. Use resettable live environments for execution comparisons. Keep structured-control and pixel-only tracks separate; pixel-only policies cannot use hidden DOM/application state.

Missing interactive Windows access means native Windows gates BLOCKED, not passed with Linux mocks. Missing provider, hardware, credentials, or external infrastructure must not prevent independent implementation/testing or justify fabricated evidence.

13. AUTONOMOUS DELIVERY AND STOP CONDITIONS

Work independently within existing permissions and recorded time/resource budgets. Make routine engineering decisions without feedback. Do not purchase services, disable protections, overwrite unrelated files, expose public control servers, or invent credentials/consent. When a permission-dependent task is blocked, continue all independent work and provide the exact remediation command later.

Maintain BUILD_STATE.md and machine-readable progress with actual commands, results, implementation decisions, and remaining blockers. Spend effort on working code, not endless architecture reports.

Deliver:
- Complete standalone source, lockfiles, schemas, native bridge, service, SDKs, and console.
- Portable seed/compiled skills with honest provenance.
- Actual initialized/trained checkpoints, inference artifacts, recorder/compiler/training code, and dataset generation instructions.
- Automated tests, frozen protocol, raw results, redacted evidence, hashes, and capability matrix.
- README, architecture/security notes, THIRD_PARTY.md, integration examples, and clean distributable archive without secrets/unrelated data.
- Implemented and tested commands for setup, doctor, start, record, compile, train, evaluate, native verification, benchmark smoke tests, export/import, and rollback.

Demonstrate the component running BEFORE describing how to plug it into another framework. Every reachable gate must be attempted; remaining outcomes must be accurately scoped. Distinguish software delivered, environments actually exercised, parameter updates executed, and learning benefit demonstrated.

Finish with the exact standalone launch command, delivered paths, actual gate results/evidence, measured learning/efficiency results, environmental blockers, and the thin integration steps for Lense/Agent-OS. Do not claim those applications were modified or integrated during this standalone build.

Begin now: establish the isolated repository → implement the core/contracts → run a complete standalone vertical slice → add real adapters → compile experience → train → evaluate → package → prove integration readiness.