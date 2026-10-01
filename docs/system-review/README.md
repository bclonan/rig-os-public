# System review and repairs

The execution receipts summarized here belong to the pre-publication source. Read [public verification](../open-source/VERIFICATION.md) for new checks and [portable evidence](../open-source/PORTABLE_EVIDENCE.md) for the source derivative. Bundled controllers require fresh local qualification.

The review found real execution defects. Repairs now preserve subskill guards and effect checks, quarantine ambiguous delivery, keep imported IDs inside intended routes, and retain failed native cleanup. The [checklist](CHECKLIST.md) records every original finding, the new capture deadline defect, regressions and remaining qualification gates.

The pre-publication implementation had 300 maintained files, SHA256 `31667d67fa52f874bc6cdcbdafc88b33a10865ef741217513a495bbfd4248700`. HEAD is `25690943be8727fc13dd2354f7a2927d3ccbfae5`. The [actual source freeze](../open-source/EVIDENCE.md) records the provenance and packaging repair. That checkpoint preceded the public source derivative. The [original review](../open-source/EVIDENCE.md), [findings](../open-source/EVIDENCE.md), [coverage](../open-source/EVIDENCE.md) and negative reproductions describe the earlier 273-file source and remain historical evidence.

## What the application does

This is a local computer-use runtime with a CLI, authenticated HTTP service, Vue console, SDK and MCP transport. SQLite stores tasks, observations, proposed actions, receipts, effects, artifacts and exact skill versions. One coordinator owns a store. Windows uses a Rust worker. macOS and Linux use Python workers with separate capture, permission and input checks.

The desktop assistant asks a configured local model to propose actions against current controls or a screenshot. A user approves each proposal. Deterministic policy, leases and fresh observation checks decide whether input may run. A model's `done` answer becomes `needs_review`. It does not prove the result happened. Wrong or missing effects block completion. Uncertain delivery requires reconciliation before another action.

The skill runtime executes version-pinned programs with durable deadlines, steps and retries. Nested calls now retain caller guards and verification. Child checks remain active too. Every active invocation constrains descendant work. Persistence cannot turn an uncertain old action into replay permission.

The learning code performs parameter updates, exports checkpoints and ONNX models, and loads qualified selectors in production. Eligibility checks remain outside the model. Controlled browser results establish a benefit over an initialized model in their stated profile. They do not establish general desktop learning or superiority to every competent authored baseline. The historical compiled library used ten observations versus fifteen separate operations. The competent macro used nine.

This repository has no signup, payment, guest passes, Convex or cloud project/chat service. The [architecture canvas](../system-map/index.html) traces local components and marks absent systems.

## Earlier verification

Fresh quality, full V4 qualification and exact archive installation passed on the frozen 300-file source. The selected model activated in a new disposable store. A separate public task and rollback passed. The historical source installation row below executed the earlier 299-file source. Native and transfer studies retain their original execution identities.

| Check | Result | Scope |
|---|---|---|
| Standard quality | PASS, eight commands on current source | 327 TypeScript tests. 87 Python cases with 18 Windows platform skips. Type checks, build, formatting, dependency audit and Windows Rust checks. |
| Historical source installation | PASS, seven commands on earlier source | Windows, setup twice, fresh dependencies and temporary-store offline/lifecycle checks. |
| Core independent repair review | PASS | 97 affected cases, unchanged stale-effect and 21-case receipt probes. |
| Service repair review | PASS | Authenticated routes, actual Vue schedules, served-browser checks and original console/lifecycle integration. Nine focused dot-ID supplement cases. |
| Capture process peer and live Linux | PASS, 51 process cases and 20 live assertions | Fault actors and protocol doubles remain separate from actual private Mutter scale-1 capture, input, permission and cancellation effects. Exact container stopped within the bound with forced exit137. That does not prove graceful container finalization. |
| Windows native effects | PASS, ten effect cases | Owned editor windows and monitor transfer. No physical mixed-DPI restoration claim. |
| Hung UIA provider | PASS for measured deadline | About 500 ms caller bound, bounded worker termination, cleanup uncertainty retained. No COM cancellation claim. |
| Full V4 qualification | PASS on current source | Completed 2,100 task cases and 300 prediction cases. Aggregate qualification gates passed. Public activation registered three models and selected seed 17 in a new disposable store. Exact selected weights and exposed cases stayed fixed. |
| Public task and rollback | PASS, separate check | Production Runtime, BrowserAdapter and ONNX completed one independently checked effect. Two requests have bound acknowledgments. Rollback restored the fixed controller and retained the completed run's model pin. |
| New family-transfer study | Measured negative | Trained weights produced 185 correct effects out of 300, initialized weights 75 and the authored controller 300. The trained transfer gate failed. |
| Exact new archive | PASS, seven commands on current source | Setup twice, lint, 327 TypeScript tests, sealed audit verification, offline execution and service lifecycle passed outside Git with fresh node_modules. Installed Node/Python dependencies and Chromium cache were reused. |

[Fresh quality](../open-source/EVIDENCE.md), [fresh V4 qualification](../open-source/EVIDENCE.md), [independent whole review](../open-source/EVIDENCE.md) and [separate task and rollback](../open-source/EVIDENCE.md) retain their actual execution identities. The completed [299-file activation failure](../open-source/EVIDENCE.md) remains unchanged. Tests do not prove every OS or arbitrary application.

The [new release ZIP](../open-source/EVIDENCE.md) has SHA256 `3f1a716d7f63d5b5858eab2075a5ac875bd4ada4a47a0167e2d3fe4679768e1a`. Its [exact installation receipt](../open-source/EVIDENCE.md) records all seven zero exits and unchanged source before and after. The original ZIP and sidecars remain unchanged. This check does not provision a fresh OS or qualify a Mac.

The [published repair ledger](CLOSURE.json), [actual saved-data verification](../open-source/EVIDENCE.md) and [actual publication](../open-source/EVIDENCE.md) bind the full current source. They record 16 repaired findings, the measured negative LR-04 result and four open gates. Earlier path-basis and reviewer metadata checker failures remain saved. They did not change product results or acceptance thresholds.

The [independent archive review](../open-source/EVIDENCE.md) checked all manifest members and seven command logs. The [independent task and rollback review](../open-source/EVIDENCE.md) checked the completed run, exact model pin and rollback state without another task execution.

## Changed boundaries

Skill and desktop execution share one typed delivery classifier. Only an exact action/run-bound rejection with `dispatched:false` proves no input. Other ambiguous outcomes stay quarantined. Journal failure cannot downgrade uncertainty. Continue and restart retain reconciliation.

Console routes encode IDs and ignore older task or connection responses. Shared validation rejects exact dot IDs before writes because URL normalization treats them specially. Custom stores no longer borrow unrelated tokens. Offline setup attempts every cleanup. Provider readers enforce byte limits before JSON decoding.

Artifact ingestion verifies existing content-hash files. Workspace grants require a trusted private directory and exclusive ownership. Cooperating operations use a root lease and opened-file identity checks. This is an application ownership contract, not an OS sandbox against hostile same-user processes.

Linux capture runs blocking GStreamer work in a separate actor. Its guardian tracks exact processes and descendants. Missing terminal cleanup proof fails. Descriptor retries must actually release retained descriptors. The measured initial 30-second PLAYING stall and earlier repair failures remain saved.

New V4 qualification signs its terminal receipt after cleanup and persistence. Activation checks the receipt. Verification commands settle owned process trees through Windows Job Objects or an isolated Linux subreaper. Unsupported command-helper hosts fail closed.

## Run it

The full [running guide](../../computer-use-runtime/docs/RUNNING.md) covers setup, tokens, models, ports, backup, shutdown, restart and recovery. To load repairs in the existing backend:

```cmd
cd /d <clone-directory>/computer-use-runtime
npm start
```

The last read-only status check reported the coordinator stopped. Keep the start terminal open. Enter `open` for the console and `copy` for the token, or use `npm run token` in a second terminal. Enter `stop` or press Ctrl+C to shut down. Use `npm restart` from another terminal when the service is already running. Verification uses temporary stores and owned windows.

## Remaining gates

Native Mac execution needs a Mac. Physical mixed-DPI qualification remains failed. External integration needs the actual hosts. General native learning needs an independent native study. The checklist retains these limits. The original frozen ledger records 61 of 63 applicable criteria and overall FAIL. Its ZIP is unchanged.
