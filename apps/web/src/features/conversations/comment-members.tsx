import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Mentionable } from "./mention-text";
import { plainMentionsByHandle } from "./message-markdown";

/**
 * The people a file's comments can name: the members of the conversation the page shows. Read by
 * the comments pane (its `@` list, and how a stored mention renders), which sits in a dialog opened
 * from a card, the Files tab or a player, so a context carries them rather than props through each.
 */
type CommentMembers = {
  /** Every active member, the viewer included: also what resolves a plain `@handle` in a body. */
  members: readonly Mentionable[];
  viewerId?: string;
  plainMentions: ReturnType<typeof plainMentionsByHandle>;
};

const CommentMembersContext = createContext<CommentMembers | undefined>(undefined);

/** The page conversation's members, for the comments of the files shown in it. */
export function CommentMembersProvider({
  members,
  viewerId,
  children,
}: {
  members: readonly Mentionable[] | undefined;
  viewerId?: string;
  children: ReactNode;
}) {
  const value = useMemo<CommentMembers | undefined>(
    () => members && { members, viewerId, plainMentions: plainMentionsByHandle(members) },
    [members, viewerId],
  );
  return <CommentMembersContext value={value}>{children}</CommentMembersContext>;
}

/** The members a comment can name; absent outside a conversation page, where `@` stays closed. */
export function useCommentMembers() {
  return useContext(CommentMembersContext);
}
