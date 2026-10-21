import type { PiChatMessage, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";

export type PiChatView = { top: number; follow: boolean; expanded: Set<string> };

export type PiChatDraft = { text: string; request?: { id: string; text: string } };

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
  previous: PiChatResult | undefined,
  read: (before?: number) => Promise<PiChatResult>,
): Promise<PiChatResult> {
  const newest = await read();
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
