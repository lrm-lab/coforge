import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeZone } from "#src/lib/time-zone-context";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { loadAttachmentComments, postAttachmentComment } from "./attachment-comments.functions";
import { MessageBody } from "./message-body";

/** Only mounted while its file is open. A draft survives switching preview/comments on a phone. */
export function AttachmentCommentsPane({ attachmentId }: { attachmentId: string }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const post = useServerFn(postAttachmentComment);
  const queryClient = useQueryClient();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const queryKey = ["attachment-comments", attachmentId];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      loadAttachmentComments({ data: { attachmentId, beforeSequence: pageParam } }),
    getNextPageParam: (page) => (page.hasOlder ? page.comments[0]?.sequence : undefined),
    refetchInterval: 5_000,
  });
  const state = query.data?.pages[0];
  const comments = query.data
    ? [...query.data.pages].reverse().flatMap((page) => page.comments)
    : [];
  const canComment = Boolean(state?.canComment && !query.isError);
  const disabledReason = state?.disabledReason;
  const disabledText =
    disabledReason === "archived"
      ? m.attachment_comments_archived()
      : disabledReason === "not-member"
        ? m.attachment_comments_not_member()
        : disabledReason === "read-only"
          ? m.attachment_comments_read_only()
          : null;
  async function submit() {
    if (!body.trim() || sending || !canComment) return;
    setSending(true);
    setSendFailed(false);
    try {
      await post({ data: { attachmentId, body } });
      setBody("");
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setSendFailed(true);
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setSending(false);
    }
  }
  return (
    <section
      aria-label={m.attachment_comments_title()}
      className="flex h-full min-h-0 min-w-0 flex-col bg-primary"
    >
      <h2 className="shrink-0 border-b border-secondary px-4 py-3 text-sm font-semibold text-primary">
        {m.attachment_comments_title()}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {query.isPending ? (
          <p className="text-sm text-tertiary">{m.attachment_comments_loading()}</p>
        ) : query.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-error-primary">
              {m.attachment_comments_load_failed()}
            </p>
            <Button size="sm" color="secondary" onClick={() => void query.refetch()}>
              {m.attachment_comments_retry()}
            </Button>
          </div>
        ) : comments.length === 0 ? (
          <Empty className="h-full p-4">
            <EmptyTitle className="text-sm text-tertiary">
              {m.attachment_comments_empty()}
            </EmptyTitle>
          </Empty>
        ) : (
          <div className="space-y-5">
            {query.hasNextPage && (
              <Button
                size="sm"
                color="tertiary"
                isLoading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {m.attachment_comments_older()}
              </Button>
            )}
            {comments.map((comment) => (
              <article key={comment.id} className="flex min-w-0 gap-2.5">
                <IdentityAvatar src={comment.senderAvatarUrl} name={comment.senderName} size="xs" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-primary">
                    {comment.senderName}
                  </p>
                  <time dateTime={comment.createdAt} className="text-xs text-tertiary">
                    {formatDateForDisplay(comment.createdAt, timeZone, getLocale(), timeFormat)}
                  </time>
                  <div className="mt-1 text-sm text-secondary">
                    <MessageBody body={comment.body} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <form
        className="shrink-0 space-y-2 border-t border-secondary p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {disabledText && <p className="text-sm text-tertiary">{disabledText}</p>}
        <TextArea
          aria-label={m.attachment_comments_input()}
          placeholder={m.attachment_comments_input()}
          value={body}
          onChange={setBody}
          maxLength={8_000}
          rows={3}
          isDisabled={!canComment || sending}
        />
        {sendFailed && (
          <p role="alert" className="text-sm text-error-primary">
            {m.attachment_comments_post_failed()}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            isDisabled={!canComment || !body.trim()}
            isLoading={sending}
          >
            {m.attachment_comments_post()}
          </Button>
        </div>
      </form>
    </section>
  );
}
