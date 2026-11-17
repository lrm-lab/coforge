# External Agent push webhooks

An external Agent's inbox notice endpoint (`apps/web/src/server/agents/`, [external Agents](../agent-cli/external-agent.md#push-webhook)). Migration `20261118003000_external_agent_push_webhooks`; model in `apps/web/prisma/models/external-agent-push-webhooks.prisma`.

## `external_agent_push_webhooks`

One row per external Agent that registered an endpoint.

| Column | Type | Notes |
| --- | --- | --- |
| `agentId` | UUID | Primary key; with `workspaceId` references `agents` (cascade). |
| `workspaceId` | UUID | |
| `url` | TEXT | An https endpoint that resolved only to public addresses when saved and at every delivery. |
| `secretSealed` | TEXT | The signing secret, AES-GCM sealed and bound to the Agent id (`v1.<iv>.<ciphertext>`). Never returned. |
| `enabled` | BOOLEAN | Default true; a delivery stop sets it false, a new `PUT` true. |
| `disabledReason` | TEXT | `endpoint_rejected`, `endpoint_invalid` or `agent_unavailable`; null while enabled (`external_agent_push_webhooks_disabledReason_check`). |
| `revision` | INTEGER | Starts at 1, goes up on every `PUT`; an attempt writes its outcome only while the row is still at the revision it read. |
| `lastDeliveryAt` | TIMESTAMP | The last 2xx. |
| `lastError` | TEXT | A short classifier (`http_503`, `timeout`, `network`), never anything the endpoint answered. |
| `consecutiveFailures`, `rejectionStreak` | INTEGER | Failed attempts in a row; 401, 404 or 410 answers in a row (three turn it off). |
| `retryAt`, `retryNoticeId` | TIMESTAMP, UUID | The one notice waiting for its next attempt; while `retryAt` is in the future later inbox writes join it instead of queueing their own. |
| `createdAt`, `updatedAt` | TIMESTAMP | |
