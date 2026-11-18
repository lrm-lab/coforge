import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
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
export type PiChatHistory = PiChatResult & {
  pendingMessages?: PiChatPendingMessage[];
};

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
  read: (before?: number, nativeCursor?: string) => Promise<PiChatResult>,
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
  if (snapshot.session?.runtime === RUNTIME_PROVIDER.CODEX) {
    const ids = new Set(old.map((item) => item.id));
    let incoming = snapshot.messages ?? [];
    let cursor = snapshot.cursor;
    for (let page = 0; cursor && page < 4 && !incoming.some((row) => ids.has(row.id)); page++) {
      const earlier = await read(undefined, cursor);
      incoming = [...(earlier.messages ?? []), ...incoming];
      cursor = earlier.cursor === cursor ? undefined : earlier.cursor;
    }
    if (!incoming.some((row) => ids.has(row.id))) return { ...newest, cursor, messages: incoming };
    const merged = new Map(old.map((message) => [message.id, message]));
    for (const item of incoming) merged.set(item.id, item);
    return { ...newest, messages: [...merged.values()], cursor: previous?.cursor };
  }
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
