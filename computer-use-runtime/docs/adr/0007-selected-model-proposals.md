# ADR 0007: Selected model proposals

Status: Accepted for the provider repair. Live provider and platform evidence remains separate from implementation.

## Decision

Desktop and Artifacts share a provider selection contract. A caller selects one to four provider/model pairs, ordered fallback or parallel evaluation, and explicit remote consent. Legacy one-model requests still select Ollama. Persisted desktop tasks freeze those choices in primitive parameters.

Every provider returns an untrusted JSON proposal. The ensemble validates all candidates against the caller's schema. Matching candidates vote together. When valid proposals tie, at most one additional call selects an existing candidate number. Invalid selection uses declared priority; cancellation returns no candidate. The selector cannot rewrite the winning proposal.

CLI clients run through fixed executable discovery, stdin prompts, bounded output and deadlines. Windows starts a suspended child in a private kill-on-close Job Object. Unix uses a detached process group and has no crash guardian. Codex uses ephemeral read-only sessions with configured integrations disabled. Claude requires API-key bare mode, has text-only support and remains unverified here.

## Consequences

The UI can compare or fall back among user-selected models without hiding the source of a proposal. Traces retain fixed failure categories and the selected member. Parallel evaluation can cost up to four proposal calls plus one selection call. CLI availability does not prove account or model access.

Model selection does not change policy, leases, freshness, input review or objective verification. This is a proposal ensemble, not a neural mixture of experts or learned router. Old fixture-learning and source-qualification receipts remain tied to their original bytes.

See [provider usage and limits](../PROVIDERS.md) and [the current architecture](../../ARCHITECTURE.md).
