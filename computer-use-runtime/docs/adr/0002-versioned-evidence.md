# 0002. Bind execution and publication to versioned evidence

Status: accepted in this review.

A paused task previously resolved a skill ID against the current registry. It could resume with different instructions. Runs now retain the root hash and nested dependency hashes. Candidate permissions belong to the test run ID. Fixture preparation runs inside the same execution lane as its test.

Publication requires three successful stored runs bound to the exact candidate hash, with completion journal entries. Arbitrary test labels no longer authorize publication. Importing an existing ID is rejected instead of replacing an installed skill. Explicit rollback remains available.

Keeping mutable IDs would make resume behavior depend on unrelated registry edits. Copying entire graphs into every run would duplicate existing immutable version storage. Hash references reuse the stored versions, but missing historical versions now block execution instead of silently selecting replacements.

Sealed audit verification is a separate read-only operation. New evidence must never replace a failed historical result. The compiler retains recorded guards and flags omitted aligned operations as uncertainty.
