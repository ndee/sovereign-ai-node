# Vendored UI dependencies

These files are committed verbatim from upstream so the setup UI runs without a
JavaScript build step. They are served by Fastify with `Cache-Control: public,
max-age=31536000, immutable`; cache busting happens by overwriting the file in a
new commit.

## Pinned versions

| File | Source | Version | sha256 |
|---|---|---|---|
| `preact.module.js` | https://cdn.jsdelivr.net/npm/preact@10.24.3/dist/preact.module.js | 10.24.3 | `4165419bca07985d7456c80da570aaee773877ba3aa0c7a8d79ec117366c286d` |
| `preact-hooks.module.js` | https://cdn.jsdelivr.net/npm/preact@10.24.3/hooks/dist/hooks.module.js | 10.24.3 | `8a3c69e8f925a8aecfcc19d4392869b9b149601db966215483026f85998ef044` |
| `htm.module.js` | https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.module.js | 3.1.1 | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |

Sums above are post-modification (see *Local edits*).

## Local edits

`preact-hooks.module.js` ships with a bare-specifier import (`from "preact"`),
which a browser cannot resolve. The single import line is rewritten to the
relative path `./preact.module.js`. The `//# sourceMappingURL=` trailer is
stripped from each file because the `.map` files are not vendored.

## Licenses

- Preact: MIT — see `LICENSE-preact.txt`.
- htm: Apache-2.0 — see `LICENSE-htm.txt`.

## Upgrade procedure

1. Pick new versions from the upstream changelogs.
2. Re-download from jsDelivr at the new version.
3. Re-apply the local edits listed above.
4. Update version numbers and recompute sha256 sums in this file.
5. Smoke-test by serving the UI locally (`pnpm dev:api`, then
   `http://localhost:8787/setup-ui/`) and exercising each screen.
