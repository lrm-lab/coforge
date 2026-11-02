/**
 * Folding runs of system messages in the message stream. Task and membership notices arrive in
 * bursts (one per claim, move or assignment), and a burst of them pushes the conversation itself
 * off screen. Every run of two or more consecutive system messages is therefore shown as one
 * summary line ("There are 3 task updates") that expands to the notices it stands for; a lone
 * system message stays as it is.
 */

import type { SystemNoticeSource } from "./system-notice-text";

export type SystemMessageKind = "taskUpdate" | "system";

/** The order a summary lists its parts in. */
const SUMMARY_ORDER: readonly SystemMessageKind[] = ["taskUpdate", "system"];

/** What a system message is about, which decides how its group is summarized: every task notice
 * (`task.*`) is a task update, anything else, an unstructured notice included, a system message.
 * The stored kind alone decides, so a notice whose params a renderer cannot read still counts. */
export function systemMessageKind(message: SystemNoticeSource): SystemMessageKind {
  return message.system?.kind.startsWith("task.") ? "taskUpdate" : "system";
}

type StreamMessage = { id: string; senderKind: string };

export type StreamItem<M extends StreamMessage> =
  | { type: "message"; message: M }
  | { type: "systemGroup"; id: string; messages: M[] };

/** The message a stream item is drawn under: a group's first, whose day the group belongs to. */
export function itemAnchor<M extends StreamMessage>(item: StreamItem<M>): M {
  return item.type === "systemGroup" ? item.messages[0]! : item.message;
}

/**
 * The stream as rendered: every message in order, except that each run of two or more
 * consecutive system messages becomes one group. `breaksRun` lets the caller keep a run from
 * crossing a line the reader must still see between two messages (a day divider, the unread
 * divider); it is asked only about a system message that follows another system message.
 */
export function groupSystemMessages<M extends StreamMessage>(
  messages: readonly M[],
  breaksRun: (message: M, previous: M) => boolean = () => false,
): StreamItem<M>[] {
  const items: StreamItem<M>[] = [];
  let run: M[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ type: "message", message: run[0]! });
    else if (run.length > 1)
      items.push({
        type: "systemGroup",
        id: `system-group:${run[0]!.id}:${run.at(-1)!.id}`,
        messages: run,
      });
    run = [];
  };
  for (const message of messages) {
    if (message.senderKind !== "system") {
      flush();
      items.push({ type: "message", message });
      continue;
    }
    const previous = run.at(-1);
    if (previous && breaksRun(message, previous)) flush();
    run.push(message);
  }
  flush();
  return items;
}

export type SystemGroupSummary = {
  total: number;
  /** Non-empty kinds only, task updates first and plain system messages last. */
  parts: { kind: SystemMessageKind; count: number }[];
};

export function summarizeSystemGroup(messages: readonly SystemNoticeSource[]): SystemGroupSummary {
  const counts = new Map<SystemMessageKind, number>();
  for (const message of messages) {
    const kind = systemMessageKind(message);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return {
    total: messages.length,
    parts: SUMMARY_ORDER.flatMap((kind) => {
      const count = counts.get(kind);
      return count ? [{ kind, count }] : [];
    }),
  };
}
