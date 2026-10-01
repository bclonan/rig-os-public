# 0004. Execute portable branches and bounded recovery with XState

Status: accepted in this review.

The earlier coordinator flattened every capsule to one linear list. It ignored state monitors and had no executable recovery targets. Extending that flattening loop would create another state machine implementation beside XState.

`runtime/program.ts` now resolves a capsule and its pinned dependencies to named execution nodes. XState executes those nodes, including explicit branches and recovery transitions. Runs persist the current node, visits, completed steps, recovery attempts and wait deadline. Old linear cursors remain readable. New fields are optional in version 1, so existing capsule bytes and hashes remain valid.

State `transitions` evaluate ordered Boolean predicates against a fresh observation. `next` is the default. An unknown predicate never matches. `onError` names a recovery state, but only a failure before dispatch may enter it. The root retry, step and deadline budgets remain authoritative. Nested invocation binds typed arguments without modifying task parameters.

State monitors run before and after actions and during waits. `waitFor` waits for a TRUE observed predicate, with observations no more frequently than every 100 ms. This is bounded observation polling. It does not claim native event subscriptions. A separate XState deadline monitor and AbortSignal bound execution. Self transitions use `reenter: true` to restart invoked actors, as documented by [XState](https://stately.ai/docs/transitions).

Recovery strings in older capsules remain descriptive metadata. Explicit `onError` states define executable repairs. Unknown delivery always enters reconciliation. Neither a new branch nor an old recovery label permits an uncertain action to repeat.

The program tests cover a real browser modal, changed readiness, UNKNOWN waits, monitor loss, empty cycles, nested input binding and lost delivery confirmation. General automatic discovery of causal guards and recovery graphs remains outside the demonstrated compiler scope.
