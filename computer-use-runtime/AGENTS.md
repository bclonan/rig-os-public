# Working in this package

Read `docs/HANDOFF.md`, `docs/DEFINITION_OF_DONE.md`, `ARCHITECTURE.md` and `docs/CODE_STYLE.md` before changing behavior. `REQUEST.md` and `acceptance.json` retain the original product contract. `docs/FEATURE_MATRIX.md` separates implemented behavior from failed or unverified gates.

- Work from this directory. Node 24.17 through 24.x is required.
- Use temporary stores for verification. Do not mutate the user's `.data/service` tasks.
- Preserve the sealed audit, seed models and historical failures. Create separate candidate artifacts.
- Models propose actions. Deterministic policy and adapter checks authorize input. A receipt is not completion evidence.
- Keep host, session, target, observation, frame, deadline and lease checks at dispatch. Never replay uncertain input.
- Keep tokens out of URLs, logs, source and release archives. Local provider requests must not follow redirects.
- Run `npm run check`. For native changes run `cargo fmt --manifest-path native/Cargo.toml -- --check` and `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings`, then the relevant live platform checks.
- Use `npx tsx evaluation/review-console.ts` for console changes and `npx tsx evaluation/service-usability.ts` for lifecycle changes.
- Update the feature matrix and handoff with actual results. Never infer a Mac result from Linux or Windows.

Commands, configuration and troubleshooting are in `docs/QUICK_REFERENCE.md`. Keep writing concrete and concise. Preserve the user's working tree and index.
