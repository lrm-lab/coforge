import { useEffect, useMemo, useRef, useState } from "react";
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
  type ComposerTarget,
} from "./artifact-comment-composer";
import type { useArtifactComments } from "./artifact-comment-queries";
import { ArtifactSidePanel } from "./artifact-side-panel";
import { CommentThreadView, type CommentContext } from "./artifact-comment-thread";
import { useArtifactCommenting, useCommentPlaces, useCommentRequests } from "./artifact-commenting";
import { orderAnchored, type CommentGroups, type CommentThread } from "./artifact-comment-threads";
import { useFlash } from "./use-flash";

export function ArtifactCommentPanel({
  artifactId,
  shownVersion,
  openPath,
  list,
  groups,
  onClose,
}: {
  artifactId: string;
  shownVersion: number;
  openPath: string | null;
  list: ReturnType<typeof useArtifactComments>;
  groups: CommentGroups;
  onClose: () => void;
}) {
  const { entryPath, filePaths } = useArtifactCommenting();
  const { focus, consumeFocus } = useCommentRequests();
  const places = useCommentPlaces();
  const { query, comments } = list;
  const known = useKnownMentionables(artifactId);
  const plainMentions = useMemo(() => plainMentionsByHandle(known), [known]);
  const [replyTo, setReplyTo] = useState<CommentReplyTarget | null>(null);
  const [fileDismissed, setFileDismissed] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [flashId, flashThread] = useFlash<string>();
  const listElement = useRef<HTMLDivElement>(null);
  const anchored = useMemo(
    () => orderAnchored(groups.anchored, [entryPath, ...filePaths], places?.byId),
    [groups.anchored, entryPath, filePaths, places],
  );
  const context: CommentContext = { artifactId, plainMentions, flashId, onReply: setReplyTo };
  const empty = groups.whole.length === 0 && anchored.length === 0 && groups.resolved.length === 0;
  useEffect(() => {
    if (focus === null) return;
    const thread = listElement.current?.querySelector(
      `[data-comment-thread="${CSS.escape(focus)}"]`,
    );
    if (!thread) return;
    consumeFocus();
    thread.scrollIntoView({ block: "nearest" });
    flashThread(focus);
  }, [focus, groups, consumeFocus, flashThread]);
  const filePath = openPath !== null && fileDismissed !== openPath ? openPath : null;
  const composerTarget: ComposerTarget = replyTo
    ? { kind: "reply", ...replyTo, onCancel: () => setReplyTo(null) }
    : filePath !== null
      ? {
          kind: "file",
          version: shownVersion,
          path: filePath,
          onClear: () => setFileDismissed(openPath),
        }
      : { kind: "panel", version: shownVersion };

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
      <div
        ref={listElement}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        aria-live="polite"
      >
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
            {anchored.length > 0 && <ThreadGroup threads={anchored} context={context} />}
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
        target={composerTarget}
        onPosted={() => setReplyTo(null)}
      />
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
      {title && <h3 className="mb-2 truncate text-xs font-semibold text-tertiary">{title}</h3>}
      <ul className="flex flex-col gap-2">
        {threads.map((thread) => (
          <CommentThreadView key={thread.root.id} thread={thread} context={context} />
        ))}
      </ul>
    </section>
  );
}
