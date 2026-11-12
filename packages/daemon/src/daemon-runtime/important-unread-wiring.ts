import { ImportantUnreadNotices, type ImportantUnreadNotice } from "./important-unread-notice";
import { ImportantUnreadReminder, type ImportantUnreadRecord } from "./important-unread-reminder";

/** What the daemon supplies so an unread batch can be put in front of its Agent: the running
 * session, what the attention index still counts as unread, and the one error a batch nobody read
 * earns. */
export type ImportantUnreadWiringPorts = Readonly<{
  store: ImportantUnreadRecord;
  /** The Agent's running session, when it has one. */
  session(agentId: string): { notify?(text: string): Promise<void> } | undefined;
  /** What the Agent has not read, as the attention index counts it. */
  unread(agentId: string): readonly { target: string; count: number }[];
  /** One error Activity for a batch whose retries ran out. */
  report(agentId: string, notice: ImportantUnreadNotice): void;
}>;

/**
 * The nudge's own words. It names where the unread messages are and how many, and never says they
 * are new: the daemon cannot know the server's read cursor, and a retry may follow a `check` that
 * already advanced it — the same reason the delivery notice avoids "unread" (task #14).
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
  return `Still not read: ${rows}. Run \`coforge inbox check\` to see them.`;
}

/** Binds the loop to the daemon: a notice goes into the running session, and a batch nobody read
 * becomes one Activity. Writing without a session is a refusal, not a success, so the loop keeps
 * its retry rather than believing the Agent was told. */
export function composeImportantUnreadReminder(ports: ImportantUnreadWiringPorts) {
  const notices = new ImportantUnreadNotices();
  return new ImportantUnreadReminder(notices, ports.store, {
    write: (agentId, notice) => {
      const session = ports.session(agentId);
      if (!session?.notify) return false;
      const text = importantUnreadNoticeText(notice, ports.unread(agentId));
      // The session queues the text into the Agent's input; a rejection this call cannot see is
      // the delivery layer's to report, so it is not treated as a refusal here.
      void session.notify(text).catch(() => undefined);
      return true;
    },
    report: (agentId, notice) => ports.report(agentId, notice),
  });
}
