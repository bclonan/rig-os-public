# Independent persistence ports

`JsonExperienceStore` and `JsonSkillRepository` implement the public contracts without extending SQLite `Store` or `Registry`. They use separate JSON files and content-addressed artifact files. The runtime still runs its normal program and verifies actual browser effects.

Inject both implementations with the seventh constructor argument.

```ts
const runtime = new Runtime(store, adapter, undefined, undefined, selector, undefined, repository);
```

The default service continues to use SQLite `Store` and `Registry`. Service management uses concrete store features such as token files and the database. The alternative example supports the runtime execution contract, not the HTTP service or learner management APIs.

Run `npx tsx --test tests/ports.test.ts` to check real browser effects, persisted journals and screenshots, idempotent submission, transaction rollback, reopening a paused run, and execution of the original pinned skill after a newer version replaces it. The same test checks SQLite transaction rollback.

Use one trusted coordinator. The JSON experience file claims ownership with an exclusive lock file. An unclean exit retains that lock and requires explicit operator recovery. Atomic file replacement and file fsync support the example's persistence checks, but the example does not claim power-loss recovery or safe simultaneous skill writers. Keep using SQLite for the service.

Transactions are synchronous. A returned Promise causes rollback. A transaction callback must not continue writing after an `await`; rejecting the Promise cannot stop code the callback already scheduled.
