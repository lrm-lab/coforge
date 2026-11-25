import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import type { ImportantUnreadNotice } from "#src/daemon-runtime/important-unread-notice";
import { unreadNoticeComposer } from "#src/daemon-runtime/important-unread-compose";
import {
  composeImportantUnreadReminder,
  consumedThroughSequence,
} from "#src/daemon-runtime/important-unread-wiring";
import { session } from "./attention-delivery";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";

/** An Agent whose cursor this process has never written: no target, no alias, no read order. */
const EMPTY_CURSOR: AgentConsumedSeqState = { targets: {}, aliases: {}, nextReadOrder: 1 };

/**
 * An attention index and the unread loop, composed as `message-composition.ts` composes them: the
 * index hands a reliable delivery to the loop instead of writing its own notice, the loop's
 * compose port builds each attempt from the batch and the queue at that moment, and — with
 * `cursor` — the index's consumed-cursor write is the one place the loop hears that the Agent has
 * read (task #14). What a test can watch is therefore what the daemon really does — notices
 * reaching the Agent's process, which path wrote each one, and what the loop recorded.
 */
export function unreadLoop(
  options: Readonly<{
    writable?: boolean;
    /** The session refuses the notice: the attempt is a rejection, exactly as a real session that
     * will not take the text is, so nothing is recorded as written and the retry stays. */
    refuse?: (notice: string) => boolean;
    /** The daemon's durable cursor, and the composition's funnel that tells the loop a read
     * position moved (`consumedSeqs` in `message-composition.ts`). */
    cursor?: boolean;
  }> = {},
) {
  const writable = options.writable ?? true;
  /** Every notice that reached the Agent's process, whichever path wrote it. */
  const notices: string[] = [];
  /** The notices the loop's own write port put there. */
  const loopNotices: string[] = [];
  const reported: string[] = [];
  const records = new Map<string, ImportantUnreadNotice>();
  const clock = { nowMs: 1_000_000 };
  /** The daemon's delivery queue, as the notice path reads it. */
  const queue: AgentMessageDelivery[] = [];
  const process = session((notice) => notices.push(notice));
  /** One run of the Agent's process, as the loop's write port sees it. */
  const processSession = () => ({
    ...process,
    notify: async (notice: string) => {
      if (options.refuse?.(notice)) throw new Error("Agent session refused the notice");
      loopNotices.push(notice);
      notices.push(notice);
    },
  });
  /** The durable cursor the index persists into, when the test wires one. */
  const cursor = new Map<string, AgentConsumedSeqState>();
  let loopSession = processSession();
  let index!: AgentMessageAttentionIndex;
  const reminder = composeImportantUnreadReminder({
    store: {
      save: (notice) => void records.set(notice.agentId, notice),
      clear: (agentId) => void records.delete(agentId),
      list: () => [...records.values()],
    },
    session: () => (writable ? loopSession : undefined),
    unread: () => index.unreadDeliveries("agent-1"),
    report: (agentId) => void reported.push(agentId),
    compose: unreadNoticeComposer({
      queued: () => queue,
      prefix: () => "",
      previewedInFull: (agentId, target, sequence) =>
        index.previewSeen.has(agentId, target, sequence),
      hasSeen: (agentId, target, sequence, conversationId) =>
        index.hasSeen(agentId, target, sequence, conversationId),
    }),
    shown: (agentId, shown) => index.previewSeen.record(agentId, shown),
    now: () => clock.nowMs,
  });
  index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => process },
    async () => {},
    () => {},
    {
      shouldHold: () => false,
      enqueue: (_agentId, message) => void queue.push(message),
      busy: () => {},
      queued: () => queue,
      noticePrefix: () => "",
      unread: (announced) => reminder.observeDeliveries(announced),
      ...(options.cursor
        ? {
            // The composition's own funnel: one write per change of what the Agent consumed, and
            // the loop hears the read position the cursor now holds.
            consumedSeqs: {
              read: (agentId) => cursor.get(agentId) ?? EMPTY_CURSOR,
              write: (agentId, state) => {
                cursor.set(agentId, state);
                reminder.consumed(agentId, consumedThroughSequence(state));
              },
            },
          }
        : {}),
    },
  );
  return {
    index,
    reminder,
    notices,
    loopNotices,
    reported,
    records,
    clock,
    queue,
    /** The Agent's process went away and a new one took its place, as after a crash or a stop. */
    replaceSession: () => {
      loopSession = processSession();
    },
  };
}

/** Lets the loop's write port finish recording what an accepted attempt showed. */
export const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
