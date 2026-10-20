# Vendored skill provenance

Third-party skills in this directory are installed with the official AI Hero
installer, run through the repository's pinned Node toolchain
(`mise exec -- npx --yes skills@1.5.23 add <source>`). `skills-lock.json`
records each skill's upstream source, path and computed content hash. Review
upstream changes before running
`mise exec -- npx --yes skills@1.5.23 update --project --yes`, and commit the
resulting lockfile and vendored files together. Updating the installer version
is a separate reviewed change. Remove a skill with the same installer
(`skills remove`) so its files and lock entry go together.

TanStack framework skills are not vendored in this directory. They ship
inside the project's `@tanstack/*` dependencies; load them through the
`@tanstack/intent` guidance in the root `AGENTS.md`. Copying them here
duplicates the installed versions and drifts from them; do not vendor them.
