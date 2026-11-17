import type { PgBoss } from "pg-boss";

export const EXTERNAL_INBOX_NOTICE_QUEUE = "external-agent-inbox-notice";

export const EXTERNAL_INBOX_NOTICE_COALESCE_SECONDS = 3;

export type ExternalInboxNoticeJob = { agentId: string; noticeId: string };

export const EXTERNAL_INBOX_NOTICE_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 0,
  expireInSeconds: 60,
} as const;

export async function sendExternalInboxNotice(
  boss: Pick<PgBoss, "send">,
  agentId: string,
  options: { noticeId?: string; delaySeconds?: number } = {},
): Promise<void> {
  await boss.send(
    EXTERNAL_INBOX_NOTICE_QUEUE,
    { agentId, noticeId: options.noticeId ?? Bun.randomUUIDv7() } satisfies ExternalInboxNoticeJob,
    {
      singletonKey: agentId,
      startAfter: options.delaySeconds ?? EXTERNAL_INBOX_NOTICE_COALESCE_SECONDS,
    },
  );
}
