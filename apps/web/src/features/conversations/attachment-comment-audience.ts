import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveMentionTargets, type MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { readMessageReferences } from "#src/lib/message-references";
import type { AttachmentCommentAudience } from "#src/server/attachments/attachment-comments.server";
import { loadAttachmentCommentAudience } from "./attachment-comments.functions";
import { attachmentCommentsQueryKey } from "./conversation-query-keys";
import { plainMentionsByHandle } from "./message-markdown";
import { mentionKey } from "./mention-text";

/**
 * Whom a comment on the file can name, and whom it notifies, as the server rules them
 * (`commentAudience`): the file's own conversation decides, never the page it is shown on. Read
 * again when a new comment arrives (`newestCommentId`), since its author is notified from then on.
 * `mentionables` are the members the `@` list offers: those a mention would notify.
 */
export function useCommentAudience(attachmentId: string, newestCommentId: string | undefined) {
  const query = useQuery({
    queryKey: [...attachmentCommentsQueryKey(attachmentId), "audience"],
    queryFn: () => loadAttachmentCommentAudience({ data: { attachmentId } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const { refetch } = query;
  const newest = useRef(newestCommentId);
  useEffect(() => {
    if (newest.current === newestCommentId) return;
    // The first comments read is what the audience was read with; only a later one is news.
    if (newest.current !== undefined) void refetch();
    newest.current = newestCommentId;
  }, [newestCommentId, refetch]);
  const audience = query.data;
  const { mentionables, plainMentions, notifies } = useMemo(
    () => ({
      mentionables: audience?.members.filter((member) => member.reads),
      plainMentions: audience && plainMentionsByHandle(audience.members),
      notifies: audience && commentNotifier(audience),
    }),
    [audience],
  );
  return { audience, mentionables, plainMentions, notifies };
}

/**
 * Who a comment notifies, by the server's rule, as a function of the comment as sent (`body` with
 * names written as handles, picked members as `mentions`): those subscribed to the file, and the
 * members it mentions, resolved among them all as a send resolves them (`resolveMentionTargets`),
 * who read its comments; never its author. Built once per audience, asked on every keystroke.
 */
export function commentNotifier(audience: AttachmentCommentAudience) {
  const members = new Map(audience.members.map((member) => [mentionKey(member), member]));
  const targets = audience.members.map((member) => ({
    key: mentionKey(member),
    type: member.kind,
    id: member.id,
    handle: member.handle,
  }));
  return (body: string, mentions: readonly MentionSelectorInput[]): string[] => {
    const named = resolveMentionTargets(
      readMessageReferences(body).candidates.handles,
      targets,
      mentions,
    ).mentions.flatMap((mention) => {
      const member = members.get(mention.key)!;
      return member.reads ? [member] : [];
    });
    const notified = new Map<string, string>();
    for (const actor of [...audience.subscribed, ...named])
      if (!(actor.kind === "user" && actor.id === audience.viewerId))
        notified.set(mentionKey(actor), actor.label);
    return [...notified.values()];
  };
}
