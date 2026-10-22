import type { PiChatMessage, PiChatResult, PiChatModel } from "@lrm/coforge-sdk/internal/pi-chat";

export type PiChatView = {
  top: number;
  follow: boolean;
  expanded: Set<string>;
  closed?: Set<string>;
};

export type PiChatDraft = {
  text: string;
  mode?: "steer" | "followUp";
  model?: PiChatModel;
  request?: { id: string; text: string };
};

export type PiChatPendingMessage = { id: string; text: string; after?: string };
export type PiChatHistory = PiChatResult & { pendingMessages?: PiChatPendingMessage[] };

/** Keep the id with the retained draft, rather than with a mounted conversation panel. */
export function preparePiChatSend(draft: PiChatDraft): PiChatDraft {
  const text = draft.text.trim();
  return {
    ...draft,
    request: draft.request?.text === text ? draft.request : { id: crypto.randomUUID(), text },
  };
}

function finalized(message: PiChatMessage) {
  return message.id !== "streaming" && !message.id.startsWith("running:");
}

/** Merge moving native-history windows, fetching until the old and new windows overlap. */
export async function loadPiChatHistory(
  previous: PiChatHistory | undefined,
  read: (before?: number) => Promise<PiChatResult>,
): Promise<PiChatHistory> {
  const snapshot = await read();
  const newest: PiChatHistory = {
    ...snapshot,
    pendingMessages: previous?.pendingMessages?.filter(
      (message) => !snapshot.session?.requestIds.includes(message.id),
    ),
  };
  const old = previous?.messages?.filter(finalized) ?? [];
  if (!old.length) return newest;
  const oldIds = new Set(old.map((message) => message.id));
  let incoming = newest.messages ?? [];
  let cursor = newest.before ?? 0;
  while (cursor > 0 && !incoming.some((message) => oldIds.has(message.id))) {
    const earlier = await read(cursor);
    if (earlier.before === undefined || earlier.before >= cursor)
      throw new Error("history cursor did not advance");
    incoming = [...(earlier.messages ?? []), ...incoming];
    cursor = earlier.before;
  }
  const merged = new Map(old.map((message) => [message.id, message]));
  for (const message of incoming) merged.set(message.id, message);
  return {
    ...newest,
    messages: [...merged.values()],
    before: Math.min(previous?.before ?? cursor, cursor),
  };
}
