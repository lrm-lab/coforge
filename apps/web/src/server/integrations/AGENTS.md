# Integrations

These rules apply to `src/server/integrations/`.

- `GitHubConnection` owns authorization attempts, encrypted user credentials,
  refresh serialization, installation and repository access, on-demand Agent
  owner user credentials, and disconnect. Do not read or refresh GitHub tokens
  elsewhere.
- A GitHub connection never creates a login identity and never confers
  Workspace authority. Callers enforce Workspace scope before using it.
- Only `repositoryOverview` performs full installation verification. The
  project browse reads (`repositoryTree`, `repositoryObject`,
  `repositoryDirectoryCommits`, `repositoryRaw`) rely on the user token's scope
  and must check repository identity in every request.
- The raw OAuth callback route is a thin adapter over this module.
- `credential()` throws `ACCESS_DENIED` only when `withToken` answers that
  the person must reconnect GitHub (`disconnected`, `reauthorize`; the Agent
  route answers `GITHUB_RECONNECT_REQUIRED`). Anything thrown, even an
  `ACCESS_DENIED` from a GitHub 403/404, is `TEMPORARILY_UNAVAILABLE`. It logs
  `github.credential_failed`, with the reason, once. A failure reason lives only in a log line, never on the thrown
  error (no `errorId`, no own property): what an error carries can reach the
  browser.
