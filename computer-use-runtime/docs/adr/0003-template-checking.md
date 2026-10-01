# 0003. Check Vue templates with a compatible TypeScript version

Status: accepted in this review.

The original build ran TypeScript on server code and Vite on Vue. It did not type-check templates. Adding vue-tsc 3.3.11 to TypeScript 7.0.2 failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `typescript/lib/tsc` before checking any code.

The package now pins TypeScript 6.0.3 and vue-tsc 3.3.11. `npm run typecheck` checks server, evaluations, examples, tests and Vue templates. `vite/client` declares CSS imports. Unused locals, unused parameters and switch fallthrough are errors. Prettier is an explicit gate.

Ignoring the loader error would leave templates unchecked. Keeping a separate TypeScript installation for templates would add version drift without benefit in this package. Future upgrades must demonstrate both checks before changing the pins.
