import { useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ChevronDown, ChevronRight } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { plainMentionsByHandle } from "#src/features/conversations/message-markdown";
import { SECTION_LABEL_CLASS } from "#src/features/conversations/review-chrome";
import { ReviewPanelHeader } from "#src/features/conversations/review-panel-header";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  ArtifactCommentComposer,
  useKnownMentionables,
  type CommentReplyTarget,
} from "./artifact-comment-composer";
import type { useArtifactComments } from "./artifact-comment-queries";
import { ArtifactSidePanel } from "./artifact-side-panel";
import { CommentThreadView, type CommentContext } from "./artifact-comment-thread";
import { useArtifactCommenting, useCommentPlaces, useCommentRequests } from "./artifact-commenting";
import {
  findThreadForComment,
  orderAnchored,
  versionSections,
  type CommentGroups,
  type CommentThread,
} from "./artifact-comment-threads";
import { useFlash } from "./use-flash";
import { useCommentDrafts } from "./artifact-comment-drafts-context";
import { ArtifactPendingReview } from "./artifact-pending-review";
import { ReviewChip, ReviewComments, ReviewFilterMenu } from "./artifact-review-view";
import type { ReviewFilter } from "./use-review-filter";

export function ArtifactCommentPanel({
  artifactId,
  shownVersion,
  pendingReview,
  list,
  groups,
  review,
  onClose,
}: {
  artifactId: string;
  shownVersion: number;
  pendingReview: boolean;
  list: ReturnType<typeof useArtifactComments>;
  groups: CommentGroups;
  review: ReviewFilter;
  onClose: () => void;
}) {
  const { entryPath, filePaths } = useArtifactCommenting();
  const { focus, consumeFocus } = useCommentRequests();
  const places = useCommentPlaces();
  const { query, comments } = list;
  const drafts = useCommentDrafts();
  const known = useKnownMentionables(artifactId);
  const plainMentions = useMemo(() => plainMentionsByHandle(known), [known]);
  const [replyTo, setReplyTo] = useState<CommentReplyTarget | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [flashId, flashThread] = useFlash<string>();
  const listElement = useRef<HTMLDivElement>(null);
  const sections = useMemo(
    () =>
      versionSections(groups, shownVersion).map((section) => ({
        ...section,
        anchored: orderAnchored(
          section.anchored,
          [entryPath, ...filePaths],
          section.version === shownVersion ? places?.byId : undefined,
        ),
      })),
    [groups, shownVersion, entryPath, filePaths, places],
  );
  const titled = sections.some((section) => section.version !== shownVersion);
  const context: CommentContext = { artifactId, plainMentions, flashId, onReply: setReplyTo };
  const empty = sections.length === 0 && groups.resolved.length === 0;
  useEffect(() => {
    if (focus === null) return;
    const match = findThreadForComment(groups, focus);
    if (match?.resolved && !resolvedOpen) {
      setResolvedOpen(true);
      return;
    }
    const targetId = match ? match.thread.root.id : focus;
    const thread = listElement.current?.querySelector(
      `[data-comment-thread="${CSS.escape(targetId)}"]`,
    );
    if (!thread) return;
    consumeFocus();
    thread.scrollIntoView({ block: "nearest" });
    flashThread(targetId);
  }, [focus, groups, resolvedOpen, consumeFocus, flashThread]);
  if (pendingReview)
    return (
      <ArtifactSidePanel
        label={m.av_dr_pending_title({ count: drafts.drafts.length })}
        onClose={onClose}
      >
        <ArtifactPendingReview
          artifactId={artifactId}
          comments={comments}
          plainMentions={plainMentions}
          onClose={onClose}
        />
      </ArtifactSidePanel>
    );
  return (
    <ArtifactSidePanel label={m.av_cm_title()} onClose={onClose}>
      <ReviewPanelHeader
        title={m.av_cm_title()}
        close={{ label: m.av_cm_close(), onPress: onClose }}
      >
        <ReviewFilterMenu filter={review} />
      </ReviewPanelHeader>
      <div
        ref={listElement}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        aria-live="polite"
      >
        {review.active ? (
          <>
            <ReviewChip filter={review} />
            <ReviewComments filter={review} context={context} plainMentions={plainMentions} />
          </>
        ) : query.isPending ? (
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
            {sections.map((section) => (
              <section
                key={section.version}
                data-version-section={section.version}
                className="flex flex-col gap-3"
              >
                {titled && (
                  <h3 className={cn(SECTION_LABEL_CLASS, "tabular-nums")}>
                    {section.version === shownVersion
                      ? m.av_cm_version_viewing({ version: section.version })
                      : m.av_cm_version_section({
                          version: section.version,
                          count: section.whole.length + section.anchored.length,
                        })}
                  </h3>
                )}
                {section.whole.length > 0 && (
                  <ThreadGroup
                    title={m.av_cm_group_whole()}
                    threads={section.whole}
                    context={context}
                  />
                )}
                {section.anchored.length > 0 && (
                  <ThreadGroup threads={section.anchored} context={context} />
                )}
              </section>
            ))}
            {groups.resolved.length > 0 && (
              <section>
                <AriaButton
                  aria-expanded={resolvedOpen}
                  className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md text-left text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:text-secondary focus-visible:outline-2"
                  onPress={() => setResolvedOpen((open) => !open)}
                >
                  {resolvedOpen ? (
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                  )}
                  {m.av_cm_resolved_group({ count: groups.resolved.length })}
                </AriaButton>
                {resolvedOpen && (
                  <ul className="mt-2 flex flex-col gap-2">
                    {groups.resolved.map((thread) => (
                      <CommentThreadView
                        key={thread.root.id}
                        thread={thread}
                        context={context}
                        versionTag
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
      </div>
      {replyTo && (
        <ArtifactCommentComposer
          artifactId={artifactId}
          target={{ kind: "reply", ...replyTo, onCancel: () => setReplyTo(null) }}
          onPosted={() => setReplyTo(null)}
        />
      )}
    </ArtifactSidePanel>
  );
}

function ThreadGroup({
  title,
  threads,
  context,
}: {
  title?: string;
  threads: readonly CommentThread[];
  context: CommentContext;
}) {
  return (
    <section>
      {title && <h3 className={cn(SECTION_LABEL_CLASS, "mb-2 truncate")}>{title}</h3>}
      <ul className="flex flex-col gap-2">
        {threads.map((thread) => (
          <CommentThreadView
            key={thread.root.id}
            thread={thread}
            context={context}
            versionTag={false}
          />
        ))}
      </ul>
    </section>
  );
}
