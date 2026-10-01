# Definition of done

The product contract is [REQUEST.md](../REQUEST.md), extended by the reviewed desktop assistant and Windows, macOS and Linux requirements in [PLATFORMS.md](../PLATFORMS.md). The frozen learning protocol in `acceptance.json` is immutable. Current code and old passing tests do not waive requirements.

Overall status is **PARTIALLY COMPLETE**. A gate becomes PASS only after the observable result below has execution evidence. External dependencies may be BLOCKED; unimplemented local behavior remains incomplete. Current results are in [VERIFICATION.md](VERIFICATION.md), with gaps retained in [FEATURE_MATRIX.md](FEATURE_MATRIX.md) and [HANDOFF.md](HANDOFF.md).

| Gate | Required observable result | Verification |
|---|---|---|
| Installation and operation | Fresh install twice, build, startup, token, stop/restart and reconnect preserve state | Clean source staging, CLI subprocess tests, live console |
| Contracts and access | Every API rejects malformed input, unauthorized hosts/origins and absent tokens; retries do not repeat effects | API negative tests and shared SDK/MCP tests |
| Durable execution | One execution lane; exact skill/model versions; cancellation, waits, takeover and uncertain delivery recover without replay | Runtime tests, crash/restart and concurrent-request tests |
| Desktop assistant | Real planning, reviewed app selection/input, correct state changes and honest completion status | Native app workflows, independent reads, provider failure/recovery |
| Platform support | Correct native adapter and capability reporting on each OS | Windows and Linux live checks; macOS requires a Mac and consent |
| Recording and portability | Before/after images, bound receipts, correction revocation, complete journal and quarantined imports | Dataset round trips, malformed bundle and long-journal tests |
| Skill compilation | Multiple demonstrations produce a parameterized draft; unseen inputs and variation tests precede publication; rollback preserves old versions | Live browser compilation and publication workflow |
| Learning | Real training, checkpoint reload and deployed inference; candidate registration and audit-gated promotion preserve sealed evidence | Existing sealed audit, separate candidate training and regression tests |
| Language/native acceptance | Editor save, Calculator result, Paint shape save and semantic dog assessment occur through native controls | Independent artifact/control checks under gate C in acceptance.json |
| Transfer and recovery | Scope, stale state, scaling/layout, dialogs, provider loss, interrupted effects and false completion are tested | Adversarial suite and native transfer checks |
| Integration | TS/Python/MCP clients and injected host contracts work; unavailable external integrations are labeled | Local live clients, contract checks; external VM/host tests when available |
| Console | Every control performs its operation, failures have recovery, state updates agree with backend, keyboard/mobile layouts work | Interaction matrix, live browser checks and screenshot inspection |
| Engineering | Formatting, core and Vue type checks, native checks and tests are repeatable commands | Automated quality gate and clean-install execution |
| Documentation | Maintained-file ledger, feature matrix, architecture diagrams, ADRs and agent guidance match current source | Second-pass source/diff review and documentation checks |

All required gates must pass to label the repository COMPLETE. Fixture learning is not general desktop learning. A model's answer or a dispatched action is not independent verification. Live Mac, physical multi-monitor and external VM results cannot be inferred from Windows/Linux tests.
