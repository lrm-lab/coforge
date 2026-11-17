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

type SendKind = "notice" | "retry" | "probe";

async function sendJob(
  boss: NoticeBoss,
  kind: SendKind,
  job: ExternalInboxNoticeJob,
  options: SendOptions,
): Promise<void> {
  const id = await boss.send(EXTERNAL_INBOX_NOTICE_QUEUE, job, options);
  if (id === null)
    console.warn(
      JSON.stringify({
        event: "external_agent.inbox_notice_send_dropped",
        kind,
        agentId: job.agentId,
      }),
    );
}

export async function sendExternalInboxNotice(
  boss: NoticeBoss,
  agentId: string,
  options: { delaySeconds?: number } = {},
): Promise<void> {
  await sendJob(
    boss,
    "notice",
    { agentId, noticeId: Bun.randomUUIDv7() },
    {
      singletonKey: agentId,
      startAfter: options.delaySeconds ?? EXTERNAL_INBOX_NOTICE_COALESCE_SECONDS,
    },
  );
}

export async function sendExternalInboxRetry(
  boss: NoticeBoss,
  agentId: string,
  noticeId: string,
  delaySeconds: number,
): Promise<void> {
  await sendJob(
    boss,
    "retry",
    { agentId, noticeId },
    { singletonKey: `${agentId}:retry`, startAfter: delaySeconds },
  );
}

export async function sendExternalInboxProbe(
  boss: NoticeBoss,
  agentId: string,
  delaySeconds: number,
): Promise<void> {
  await sendJob(
    boss,
    "probe",
    { agentId, probe: true },
    { singletonKey: `${agentId}:probe`, startAfter: delaySeconds },
  );
}
