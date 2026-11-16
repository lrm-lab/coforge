import { useMemo, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ChevronDown, ChevronRight, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import { plainMentionsByHandle } from "#src/features/conversations/message-markdown";
import { m } from "#src/paraglide/messages";
import {
  ArtifactCommentComposer,
  useKnownMentionables,
  type CommentReplyTarget,
} from "./artifact-comment-composer";
import { useArtifactComments } from "./artifact-comment-queries";
import { ArtifactSidePanel } from "./artifact-side-panel";
import { CommentThreadView, type CommentContext } from "./artifact-comment-thread";
import { groupThreads, type CommentThread } from "./artifact-comment-threads";

export function ArtifactCommentPanel({
  artifactId,
  shownVersion,
  openPath,
  focusRequest,
  onClose,
}: {
  artifactId: string;
  shownVersion: number;
  openPath: string | null;
  focusRequest: number;
  onClose: () => void;
}) {
  const { query, comments } = useArtifactComments(artifactId);
  const known = useKnownMentionables(artifactId);
  const plainMentions = useMemo(() => plainMentionsByHandle(known), [known]);
  const [replyTo, setReplyTo] = useState<CommentReplyTarget | null>(null);
  const [fileDismissed, setFileDismissed] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const groups = useMemo(() => groupThreads(comments), [comments]);
  const context: CommentContext = { artifactId, plainMentions, onReply: setReplyTo };
  const empty =
    groups.whole.length === 0 && groups.files.length === 0 && groups.resolved.length === 0;
  const target = openPath !== null && fileDismissed !== openPath ? openPath : null;

  return (
    <ArtifactSidePanel label={m.av_cm_title()} onClose={onClose}>
      <header className="flex shrink-0 items-center gap-2 border-b border-secondary py-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">
          {m.av_cm_title()}
        </h2>
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={m.av_cm_close()}
          onClick={onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {query.isPending ? (
          <div aria-busy="true" className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError && comments.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-error-primary">
              {m.av_cm_load_failed()}
            </p>
            <Button size="sm" color="secondary" onClick={() => void query.refetch()}>
              {m.av_cm_retry()}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {query.hasNextPage && (
              <div className="flex flex-col items-center gap-1">
                {query.isFetchNextPageError && (
                  <p role="alert" className="text-xs text-error-primary">
                    {m.av_cm_older_failed()}
                  </p>
                )}
                <Button
                  size="sm"
                  color="tertiary"
                  isLoading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchNextPageError ? m.av_cm_retry() : m.av_cm_older()}
                </Button>
              </div>
            )}
            {empty && !query.hasNextPage && (
              <p className="text-sm text-tertiary">{m.av_cm_empty()}</p>
            )}
            {groups.whole.length > 0 && (
              <ThreadGroup title={m.av_cm_group_whole()} threads={groups.whole} context={context} />
            )}
            {groups.files.map((file) => (
              <ThreadGroup
                key={file.path}
                title={file.path}
                threads={file.threads}
                context={context}
                hideAnchor
              />
            ))}
            {groups.resolved.length > 0 && (
              <section>
                <AriaButton
                  aria-expanded={resolvedOpen}
                  className="flex w-full cursor-pointer items-center gap-1 rounded-md py-1 text-left text-xs font-semibold text-tertiary outline-focus-ring hover:text-secondary focus-visible:outline-2"
                  onPress={() => setResolvedOpen((open) => !open)}
                >
                  {resolvedOpen ? (
                    <ChevronDown aria-hidden="true" className="size-4" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-4" />
                  )}
                  {m.av_cm_resolved_group({ count: groups.resolved.length })}
                </AriaButton>
                {resolvedOpen && (
                  <ul className="mt-2 flex flex-col gap-2">
                    {groups.resolved.map((thread) => (
                      <CommentThreadView key={thread.root.id} thread={thread} context={context} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
      </div>
      <ArtifactCommentComposer
        artifactId={artifactId}
        version={shownVersion}
        path={target}
        replyTo={replyTo}
        focusRequest={focusRequest}
        onClearPath={() => setFileDismissed(openPath)}
        onCancelReply={() => setReplyTo(null)}
      />
    </ArtifactSidePanel>
  );
}

function ThreadGroup({
  title,
  threads,
  context,
  hideAnchor,
}: {
  title: string;
  threads: readonly CommentThread[];
  context: CommentContext;
  hideAnchor?: boolean;
}) {
  return (
    <section>
      <h3 className="mb-2 truncate text-xs font-semibold text-tertiary">{title}</h3>
      <ul className="flex flex-col gap-2">
        {threads.map((thread) => (
          <CommentThreadView
            key={thread.root.id}
            thread={thread}
            context={context}
            hideAnchor={hideAnchor}
          />
        ))}
      </ul>
    </section>
  );
}
