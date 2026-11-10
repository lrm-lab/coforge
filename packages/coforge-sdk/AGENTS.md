# CoForge SDK

- `bun run generate` rewrites `src/`; format the result with `bunx oxfmt src` before committing. Nothing else in the repo formats this package, and `bun run check` runs `oxfmt --check .`, so a stale format turns `Validate libraries` red.
