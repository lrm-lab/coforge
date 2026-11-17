import type { SendOptions } from "pg-boss";

export type NoticeBoss = {
  send(name: string, data: object, options: SendOptions): Promise<string | null>;
};

export const EXTERNAL_INBOX_NOTICE_QUEUE = "external-agent-inbox-notice";

export const EXTERNAL_INBOX_NOTICE_COALESCE_SECONDS = 3;

export type ExternalInboxNoticeJob =
  | { agentId: string; noticeId: string }
  | { agentId: string; probe: true };

export const EXTERNAL_INBOX_NOTICE_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 0,
  expireInSeconds: 60,
} as const;

export async function sendExternalInboxNotice(
  boss: NoticeBoss,
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

export async function sendExternalInboxProbe(
  boss: NoticeBoss,
  agentId: string,
  delaySeconds: number,
): Promise<void> {
  await boss.send(
    EXTERNAL_INBOX_NOTICE_QUEUE,
    { agentId, probe: true } satisfies ExternalInboxNoticeJob,
    { singletonKey: `${agentId}:probe`, startAfter: delaySeconds },
  );
}
