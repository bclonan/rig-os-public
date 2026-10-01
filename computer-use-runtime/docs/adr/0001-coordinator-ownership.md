# 0001. Serialize coordinator ownership in SQLite

Status: accepted in this review.

The former PID-file check could race when two processes removed the same stale file. A new coordinator now claims a singleton SQLite row inside `BEGIN IMMEDIATE`. The existing PID file remains for CLI and older-coordinator detection. Shutdown removes only the owner's claim and PID file. Submission records and idempotency keys commit in one transaction.

An exclusive file creation alone does not solve stale-file replacement races. A separate locking dependency was another option; SQLite already supplies the serialization needed here. This follows SQLite's [transaction semantics](https://www.sqlite.org/lang_transaction.html). A live PID with unavailable service still needs operator inspection. PID reuse conservatively blocks startup.

Four concurrent real Node processes recover one stale PID file in `tests/store-recovery.test.ts`; exactly one acquires the store. Another test verifies rollback of partial writes. This does not establish network-filesystem support.

A final Linux run exposed SQLITE_BUSY while multiple processes initialized WAL before the ownership transaction. SQLite can bypass its busy handler during that mode switch. Idempotent initialization now retries SQLITE_BUSY for at most three seconds. The ownership claim and all input operations remain outside that retry. Ten repeated Windows runs and twenty Linux runs each admitted one owner and rejected three contenders.
