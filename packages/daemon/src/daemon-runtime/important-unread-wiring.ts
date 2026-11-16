import { ImportantUnreadNotices, type ImportantUnreadNotice } from "./important-unread-notice";
import {
  ImportantUnreadReminder,
  type ImportantUnreadBatchDelivery,
  type ImportantUnreadComposedNotice,
  type ImportantUnreadRecord,
} from "./important-unread-reminder";

/** What the daemon supplies so an unread batch can be put in front of its Agent: the running
 * session, what the attention index still counts as unread, and the one error a batch nobody read
 * earns. */
export type ImportantUnreadWiringPorts = Readonly<{
  store: ImportantUnreadRecord;
  /** The Agent's running session, when it has one. */
  session(
    agentId: string,
  ):
    | { notify?(text: string): Promise<void>; waitForContextViewCapture?(): Promise<void> }
    | undefined;
  /** What the Agent has not read, as the attention index counts it. */
  unread(agentId: string): readonly { target: string; count: number }[];
  /** One error Activity for a batch whose retries ran out. */
  report(agentId: string, notice: ImportantUnreadNotice): void;
  /** The batch's own notice as it reads now, composed by the attention index from the Agent's
   * current unread. Every attempt asks again, so a retry counts what arrived since. */
  compose?(
    agentId: string,
    notice: ImportantUnreadNotice,
    deliveries: readonly ImportantUnreadBatchDelivery[],
  ): ImportantUnreadComposedNotice | undefined;
  /** The messages whose whole text an accepted attempt put in front of the model, so the next one
   * does not repeat them. */
  shown?(agentId: string, shown: readonly { target: string; sequence: number }[]): void;
  /** The clock the retry schedule is measured on. */
  now?(): number;
}>;

/**
 * The nudge's own words, used only when nothing can be composed from the batch. It names where the
 * messages are and how many, and says "waiting", not "unread": the daemon does not know the
 * server's read cursor, and a retry may follow a `check` that already advanced it (task #14). The
 * choice was raft's — keep the wording neutral rather than loosen the rule about cursor-dependent
 * words.
 */
export function importantUnreadNoticeText(
  notice: ImportantUnreadNotice,
  unread: readonly { target: string; count: number }[],
): string {
  const rows = (
    unread.length
      ? unread
      : // A retry can outlive the index's own count (a restart clears it): fall back to the
        // conversations the batch named, so the nudge still says where to look.
        notice.conversations.flatMap((conversation) =>
          conversation.target ? [{ target: conversation.target, count: conversation.count }] : [],
        )
  )
    .map((row) => `${row.target} (${row.count})`)
    .join(", ");
  return `Still waiting: ${rows}. Run \`coforge inbox check\` to see them.`;
}

/** Binds the loop to the daemon: a notice goes into the running session, and a batch nobody read
 * becomes one Activity. Writing without a session is a refusal, not a success, so the loop keeps
 * its retry rather than believing the Agent was told. */
export function composeImportantUnreadReminder(ports: ImportantUnreadWiringPorts) {
  const notices = new ImportantUnreadNotices();
  return new ImportantUnreadReminder(
    notices,
    ports.store,
    {
      write: (agentId, notice, attempt) => {
        const session = ports.session(agentId);
        if (!session?.notify) return false;
        // A retry says what this attempt composed; only a record taken over after a restart, whose
        // words did not survive, falls back to the standing text.
        const text = attempt?.text ?? importantUnreadNoticeText(notice, ports.unread(agentId));
        // The session queues the text into the Agent's input, and the promise is this attempt's
        // verdict: it rejects when the session refused the notice, so the retry stays and the
        // delivery that asked for the attempt hears the refusal.
        return Promise.resolve(session.notify(text)).then(async () => {
          await session.waitForContextViewCapture?.();
          if (attempt?.shown?.length) ports.shown?.(agentId, attempt.shown);
        });
      },
      report: (agentId, notice) => ports.report(agentId, notice),
      session: (agentId) => ports.session(agentId),
      ...(ports.compose
        ? {
            compose: (agentId, notice, deliveries) => ports.compose!(agentId, notice, deliveries),
          }
        : {}),
    },
    ports.now,
  );
}
