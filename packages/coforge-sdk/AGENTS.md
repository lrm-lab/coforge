# CoForge SDK

- `bun run generate` rewrites `src/`; format the result with `bunx oxfmt src` before committing. Nothing else in the repo formats this package, and `bun run check` runs `oxfmt --check .`, so a stale format turns `Validate libraries` red.

- Protobuf schemas under `packages/coforge-sdk/proto` must pass `buf lint` and `buf format --diff --exit-code`; do not use TypeScript lint rules as a substitute for `.proto` validation.
