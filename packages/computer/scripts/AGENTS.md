# Computer build scripts

These files live outside `src/` and are never bundled into the Computer. Paths are relative to
the package.

`scripts/compile-release.ts`, the release build, imports only relative paths and `#src/`: CI's
native jobs run it from an install of this workspace alone, with no root `node_modules`.

`scripts/installer-contract.ts` (outside `src/`, never bundled) generates
`crates/installer/contract/`, the cross-language contract with the Rust installer:
JSON Schema via `z.toJSONSchema()` plus golden files. This package is its source
of truth; each shape's zod schema lives in the module that owns the concept
(`updater.ts`, `release/installer-contract.ts`, and the upgrade receipt in
`@lrm/coforge-sdk/internal/upgrade-receipt`, which the Daemon's single receipt reader also uses).
`scripts/installer-receipt-cases.ts` holds, as literals, the receipts that schema accepts
and refuses; the Rust crate builds and checks every row.
After changing a contract shape or a value it exports (paths, service names,
launchers, lock, feed environments), run `bun run generate:installer-contract`
and commit the result; `test/installer-contract.test.ts` and CI fail otherwise.
