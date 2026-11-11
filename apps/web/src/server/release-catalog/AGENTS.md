# Release catalog

These rules apply to `src/server/release-catalog/`.

- The catalog is self-contained and split-ready: it is meant to leave the Web for its own service
  whole. It knows apps and versions only, never Workspaces, Computers, Users or Agents.
- Import no other Web domain module (`server/workspaces`, `server/computers`, `server/agents`,
  `server/auth`, …) and no `features/` code. Allowed: the shared Prisma client
  (`server/db/client.server.ts`), the generated Prisma types, and generic libraries (`zod`, the
  SDK's release-version helpers and notes limit). Other modules may import its public read
  (`productionReleaseCatalog().getReleaseNotes`), never its store.
- Its persistence stays here (`release-catalog.repositories.server.ts`), not in
  `server/db/repositories/`, and its table `release_catalog_releases` has no relation to any other
  table.
- The REST contract is `/api/release-catalog/v1/apps/{app}/releases/{version}`: GET is public,
  PUT publishes. The route file forwards to `release-catalog-http.server.ts`; keep it that thin.
- Publishing needs `Authorization: Bearer <token>`. The deployment configures only the token's
  lowercase hex SHA-256 in `COFORGE_RELEASE_CATALOG_PUBLISH_TOKEN_SHA256`; the plaintext token
  never appears in Web config, code or logs. An unset or malformed hash disables publishing (503),
  a missing or wrong bearer is 401, and the check runs before the body is read.
- Limits: `app` matches `^[a-z0-9][a-z0-9-]{0,62}$`, `version` passes the SDK's
  `isValidReleaseVersion`, and each of `en` and `zh-CN` is required, trimmed, non-empty and at most
  the SDK's `RELEASE_NOTES_MAX_LENGTH` characters (shared with
  `scripts/release/release-notes.ts`). A PUT overwrites earlier notes, so a reader revalidates
  (`cache-control: no-cache`).
