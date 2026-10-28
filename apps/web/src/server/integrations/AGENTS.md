# Integrations

These rules apply to `src/server/integrations/`.

- `GitHubConnection` is the entry point: authorization attempts, installation
  and repository access, on-demand Agent owner user credentials, and
  disconnect. It composes the modules below; callers use it, not them,
  apart from the shape types (`RepositorySelection`).
  - `github-user-tokens.server.ts` (`GitHubUserTokens`) is the only code that
    reads, refreshes, rewrites, or clears a User's stored tokens, serialized per
    User. Do not read or refresh GitHub tokens elsewhere.
  - `github-sealed-values.server.ts` seals and opens encrypted credentials.
  - `github-api.server.ts` (`GitHubApi`) is the HTTP transport to GitHub and
    owns the failure-reason mapping; `github-installation-cache.server.ts`
    reads and caches the User's App installations.
  - `github-repository-browser.server.ts` serves the repository reads. It gets
    tokens only through the connection's `withToken`.
  - `github-account-shapes.server.ts` and `github-repository-shapes.server.ts`
    hold the response schemas, GraphQL queries, and mapping for the account and
    repository sides.
- A GitHub connection never creates a login identity and never confers
  Workspace authority. Callers enforce Workspace scope before using it.
- Only `repositoryOverview` performs full installation verification. The
  project browse reads (`repositoryTree`, `repositoryObject`,
  `repositoryDirectoryCommits`, `repositoryRaw`) rely on the user token's scope
  and must check repository identity in every request.
- A token GitHub issues during an authorization that ends up not stored is revoked, best effort,
  never delaying or changing the outcome. Connects of one GitHub account are serialized; lock
  order is User, then account.
- The raw OAuth callback route is a thin adapter over this module.
- `credential()` throws `ACCESS_DENIED` only when `withToken` answers that
  the person must reconnect GitHub (`disconnected`, `reauthorize`; the Agent
  route answers `GITHUB_RECONNECT_REQUIRED`). Anything thrown, even an
  `ACCESS_DENIED` from a GitHub 403/404, is `TEMPORARILY_UNAVAILABLE`. It logs
  `github.credential_failed`, with the reason, once. A failure reason lives only in a log line, never on the thrown
  error (no `errorId`, no own property): what an error carries can reach the
  browser.
- The Agent commit `Co-authored-by` trailer names only the regular GitHub user
  account configured in `COFORGE_COMMIT_COAUTHOR` (`readCommitCoAuthor`), never
  the GitHub App's `[bot]` account, which GitHub shows without a profile or
  hovercard. Unset means no trailer for any repository.
