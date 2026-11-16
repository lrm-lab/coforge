# CoForge SDK

- `bun run generate` rewrites `src/`; format the result with `bun run format` before committing; `bun run check` runs `oxfmt --check .`.

- Protobuf schemas under `packages/coforge-sdk/proto` must pass `buf lint` and `buf format --diff --exit-code`; do not use TypeScript lint rules as a substitute for `.proto` validation.
