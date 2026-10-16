# Production GitHub connection

The production GitHub App is `CoForge App` (slug `coforge-app`) in the `lrm-lab` organization: App ID
`5345306`, Client ID `Iv23licriUAnCqt6MlHg`. Both are public and set in
`infra/production/docker-compose.yml`. Its settings match the staging App
([staging runbook](../staging/github-connection.md), which explains each
permission and webhook choice) with production URLs:

- Homepage `https://coforge.cn`; public, so any account or organization can
  install it.
- Callback URL `https://coforge.cn/api/integrations/github/callback`, with
  expiring user access tokens and **Request user authorization (OAuth) during
  installation** enabled, and **Redirect on update** disabled.
- Webhook active at `https://coforge.cn/api/integrations/github/webhook`, with
  no event subscriptions.
- Repository permissions: Actions (write), Checks (read), Contents (write),
  Metadata (read), Pull requests (write), Commit statuses (read), Workflows
  (write). No organization or account permissions.

## Host secrets

Production does not read GitHub values from the GitHub `production`
Environment: `remote-deploy.sh` reads them from files in
`~/coforge-production/infra/production/secrets/` on the host (mode 600, backed
up with the other host secrets; see [the runbook](README.md#secrets-directory)).
Generate each value on the host; never paste it into chat or CI logs.

- `coforge_github_client_secret`: generated in the App settings.
- `coforge_github_credential_encryption_key`: `openssl rand -hex 32`. Keep it
  across deployments; replacing it makes stored GitHub credentials unreadable.
- `coforge_github_app_slug`: the slug from the App's public URL.
- `coforge_github_webhook_secret` (optional): `openssl rand -hex 32`, entered
  verbatim as the App's webhook secret. Absent, the webhook route answers 503
  and Settings falls back to background sync.
- `coforge_github_app_bot_user_id` (optional):
  `gh api 'users/<slug>[bot]' --jq .id`.

Write the first three together, then redeploy. Without a client secret or
encryption key, Settings shows GitHub as not configured; with them but with an
invalid slug or a key that is not 64 hex characters, the integration answers
`TEMPORARILY_UNAVAILABLE` instead.

## Acceptance

After the redeploy, run the staging manual acceptance checklist against
`https://coforge.cn` (Settings → Integrations: connect, cancel, change account,
configure, revoke, disconnect, and the webhook-driven suspend and uninstall).
