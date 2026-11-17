# External Agent push webhooks

An external Agent's inbox notice endpoint (`apps/web/src/server/agents/`, [external Agents](../agent-cli/external-agent.md#push-webhook)). Migrations `20261118003000_external_agent_push_webhooks` and `20261118004000_external_agent_push_recovery`; model in `apps/web/prisma/models/external-agent-push-webhooks.prisma`.

## `external_agent_push_webhooks`

One row per external Agent that registered an endpoint.

| Column | Type | Notes |
| --- | --- | --- |
| `agentId` | UUID | Primary key; with `workspaceId` references `agents` (cascade). |
| `workspaceId` | UUID | |
| `url` | TEXT | An https endpoint that resolved only to public addresses when saved and at every delivery. |
| `secretSealed` | TEXT | The signing secret, AES-GCM sealed and bound to the Agent id (`v1.<iv>.<ciphertext>`). Never returned. |
| `disabledReason` | TEXT | `endpoint_rejected`, `endpoint_invalid` or `agent_unavailable`; null while push is on (`external_agent_push_webhooks_disabledReason_check`). |
| `revision` | INTEGER | Starts at 1, goes up on every `PUT`; an attempt writes its outcome only while the row is still at the revision it read. |
| `lastDeliveryAt` | TIMESTAMP | The last 2xx. |
| `lastError` | TEXT | A short classifier (`http_503`, `timeout`, `network`), never anything the endpoint answered. |
| `consecutiveFailures`, `rejectionStreak` | INTEGER | Failed attempts in a row; rejections in a row (404 or 410 turn it off at three; 401 only when `unauthorizedSince` is also 24 hours old). |
| `retryAt`, `retryNoticeId` | TIMESTAMP, UUID | The one notice waiting for its next attempt; while `retryAt` is in the future later inbox writes join it instead of queueing their own. |
| `createdAt`, `updatedAt` | TIMESTAMP | |
| `unauthorizedSince` | TIMESTAMP | When the current run of 401 answers began; null while the last rejection was not a 401. |
| `disabledAt` | TIMESTAMP | When push was last turned off; the 30-day probe window counts from it. |
| `nextProbeAt` | TIMESTAMP | The next recovery probe of an `endpoint_rejected` webhook; null when none is planned. Read at worker start to re-enqueue the probe job. |
| `probeAttempts` | INTEGER | Probes sent since it turned off; sets the gap to the next one. |
| `probeStoppedAt` | TIMESTAMP | When probing gave up after 30 days; only a new `PUT` turns push on then. |
