import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversationOpenQuery } from "./conversation-open-query";
import { openState, type OpenRead } from "./conversation-open-state";
import type { FirstUnread } from "#src/server/conversations/conversation-open.server";

/**
 * This open's read of where the viewer's unread starts in a conversation, or in one thread of it
 * (`conversationOpenQuery`). Every observer of one open shares it: the pane's divider and landing,
 * and the read cursor's writes, which wait for it. `enabled` false reads nothing (a pane that
 * keeps no cursor, such as a Task popup's discussion the viewer has no seat in).
 *
 * The open ends when the last observer that reads it is gone (the conversation or thread was
 * left), and the read is dropped then, so the next open reads again. One that stays (the page
 * while its Files tab replaces the pane) keeps it for the visit; the check waits a tick, so a
 * remount in the same commit is no leaving.
 */
export function useConversationOpenRead(
  conversationId: string,
  rootId?: string,
  enabled = true,
): OpenRead {
  const read = useQuery({ ...conversationOpenQuery(conversationId, rootId), enabled });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const { queryKey } = conversationOpenQuery(conversationId, rootId);
    return () => {
      setTimeout(() => {
        const query = queryClient.getQueryCache().find({ queryKey, exact: true });
        if (query && !query.isActive()) queryClient.removeQueries({ queryKey, exact: true });
      });
    };
  }, [queryClient, conversationId, rootId, enabled]);
  // A read marked stale and being read again (an Activity row opening with where unread starts,
  // task #102) is not this open's until the new one lands: the open goes by the opener's
  // meanwhile, and the read cursor waits. An open already settled keeps what it froze.
  if (read.isSuccess && !(read.isStale && read.isFetching))
    return { status: "success", firstUnread: read.data.firstUnread };
  return { status: read.isError ? "error" : "pending" };
}

/**
 * Where the viewer's unread starts in the conversation a host opens, as the host read it already
 * (`HostedConversationTarget.unreadFrom`, an Activity row): the main stream's open takes it at
 * once rather than after its own read (task #102). Threads and other conversations ignore it.
 */
export const OpenUnreadHintContext = createContext<{
  conversationId: string;
  messageId: string;
} | null>(null);

/** Whether this open's read is in (`useConversationOpenRead`): the read cursor's writes wait for it. */
export function useConversationOpened(conversationId: string, rootId?: string, enabled = true) {
  return useConversationOpenRead(conversationId, rootId, enabled).status === "success";
}

/**
 * The divider and landing of one conversation or thread open, frozen once its read is in
 * (`openState`): the read cursor moving while it is open does not move them.
 *
 * `openKey` changes when the pane should take its open position again: at once when the open is
 * settled on the first render, else when it settles, but only for a reader who has stayed at the
 * latest all the while; one who has moved away meanwhile (or opened on a jump) stays where they are.
 */
export function useConversationOpen(
  {
    conversationId,
    messages,
  }: { conversationId: string; messages: readonly { id: string; sequence: number }[] },
  rootId: string | undefined,
  followingLatest: boolean,
  {
    keepsCursor = true,
    loadAround,
  }: {
    /** False for a pane with no read cursor of its own: it opens at its latest, with no divider. */
    keepsCursor?: boolean;
    /** Replaces the main stream's window with the one around a message (`loadMessageAround`). */
    loadAround?: (messageId: string) => Promise<unknown>;
  } = {},
): { boundary?: FirstUnread; openKey: string } {
  const read = useConversationOpenRead(conversationId, rootId, keepsCursor);
  const key = `${conversationId}:${rootId ?? ""}`;
  const hint = useContext(OpenUnreadHintContext);
  const unreadFrom =
    !rootId && hint?.conversationId === conversationId ? hint.messageId : undefined;
  const state = keepsCursor ? openState(read, messages, unreadFrom) : { waiting: false as const };
  const settle = (waiting?: Waiting): Opened => ({
    key,
    boundary: state.waiting ? undefined : state.boundary,
    openKey: waiting?.strayed ? `${conversationId}:opening` : conversationId,
    provisional: !state.waiting && state.provisional,
  });
  const [opened, setOpened] = useState<Opened | Waiting>(() =>
    state.waiting ? { key, waiting: true, strayed: !followingLatest } : settle(),
  );
  const current = opened.key === key ? opened : undefined;
  // Set during render, as derived state: the pane's open effect sees it in the same commit.
  if (state.waiting) {
    if (!current) setOpened({ key, waiting: true, strayed: !followingLatest });
    else if ("waiting" in current && !current.strayed && !followingLatest)
      setOpened({ ...current, strayed: true });
  } else if (!current || "waiting" in current) {
    setOpened(settle(current && "waiting" in current ? current : undefined));
  } else if (current.provisional && !state.provisional) {
    // The read is in after an opener's position: it wins for the divider, while the landing
    // stays where the pane already put the reader (Raft, task #102).
    setOpened({ ...current, boundary: state.boundary, provisional: false });
  }
  // The main stream's first unread is older than all its window holds: read around it, once.
  const readAround = state.waiting && !rootId ? state.readAround : undefined;
  const readingAround = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!readAround || !loadAround || readingAround.current === `${key}:${readAround}`) return;
    readingAround.current = `${key}:${readAround}`;
    void loadAround(readAround).catch(() => undefined);
  }, [readAround, loadAround, key]);
  const shown = current && !("waiting" in current) ? current : undefined;
  return {
    boundary: shown?.boundary,
    openKey: shown?.openKey ?? `${conversationId}:opening`,
  };
}

/** `provisional`: settled on the opener's position (`OpenUnreadHintContext`), before the read. */
type Opened = { key: string; boundary?: FirstUnread; openKey: string; provisional?: boolean };
/** `strayed`: the reader left the latest while the open waited, so it does not move them. */
type Waiting = { key: string; waiting: true; strayed: boolean };
