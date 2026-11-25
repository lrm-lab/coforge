import type { AgentSession } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  ImportantUnreadNotices,
  unreadConversationEligible,
  type ImportantUnreadNotice,
} from "./important-unread-notice";
import type { NoticeEligibility } from "./notice-eligibility";
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
  session(agentId: string): Pick<AgentSession, "notify" | "waitForContextViewCapture"> | undefined;
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
  eligibility?: NoticeEligibility;
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
const logger = getLogger(["coforge", "daemon", "message-attention"]);

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
        const identity = {
          agent_id: agentId,
          notice_key: notice.key,
          attempt_id: crypto.randomUUID(),
          request_ids: attempt?.requestIds,
        };
        logger.info("Reliable inbox notice handed to the session", {
          ...identity,
          event: "agent.inbox_notice.admission_requested",
          attempt: notice.attempts + 1,
        });
        const eligibility = ports.eligibility;
        const summary = eligibility
          ? () => {
              const retained = notice.conversations.filter((conversation) =>
                unreadConversationEligible(notice, conversation, eligibility),
              );
              if (!retained.length) return undefined;
              const targets = new Set(retained.map(({ target }) => target));
              const unread = ports.unread(agentId).filter((entry) => targets.has(entry.target));
              return importantUnreadNoticeText({ ...notice, conversations: retained }, unread);
            }
          : undefined;
        const prepare = attempt?.prepareSubmission ?? summary;
        const options =
          attempt?.fallbackText || prepare
            ? {
                fallbackText: attempt?.fallbackText,
                prepareSubmission: prepare
                  ? (boundary: "prompt" | "steer") => {
                      const next = prepare(boundary);
                      logger.info("Reliable inbox notice submission decided", {
                        ...identity,
                        event: "agent.inbox_notice.submission_decision",
                        boundary,
                        outcome: next === undefined ? "suppress" : "submit",
                      });
                      return next;
                    }
                  : undefined,
                onPromptWritten: () =>
                  logger.info("ACP prompt written for reliable inbox notice", {
                    ...identity,
                    event: "agent.inbox_notice.acp_prompt_written",
                  }),
              }
            : undefined;
        return Promise.resolve(options ? session.notify(text, options) : session.notify(text)).then(
          async () => {
            await session.waitForContextViewCapture?.();
            const currentContext = attempt?.accepted?.() !== false;
            if (currentContext && attempt?.shown?.length) ports.shown?.(agentId, attempt.shown);
          },
        );
      },
      report: (agentId, notice) => ports.report(agentId, notice),
      eligibility: ports.eligibility,
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
