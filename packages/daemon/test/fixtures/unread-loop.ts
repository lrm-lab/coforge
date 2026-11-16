import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import type { ImportantUnreadNotice } from "#src/daemon-runtime/important-unread-notice";
import { unreadNoticeComposer } from "#src/daemon-runtime/important-unread-compose";
import { composeImportantUnreadReminder } from "#src/daemon-runtime/important-unread-wiring";
import { session } from "./attention-delivery";

/**
 * An attention index and the unread loop, composed as `message-composition.ts` composes them: the
 * index hands a reliable delivery to the loop instead of writing its own notice, and the loop's
 * compose port builds each attempt from the batch and the queue at that moment (task #14). What a
 * test can watch is therefore what the daemon really does — notices reaching the Agent's process,
 * which path wrote each one, and what the loop recorded.
 */
export function unreadLoop(options: Readonly<{ writable?: boolean }> = {}) {
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
      loopNotices.push(notice);
      notices.push(notice);
    },
  });
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
