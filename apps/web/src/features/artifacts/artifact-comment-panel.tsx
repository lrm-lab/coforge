import { useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare01,
  SearchLg,
  SwitchVertical01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { plainMentionsByHandle } from "#src/features/conversations/message-markdown";
import {
  SECTION_LABEL_CLASS,
  TOOLBAR_BUTTON_ON_CLASS,
} from "#src/features/conversations/review-chrome";
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
  filterCommentGroups,
  orderAnchored,
  planCommentFocus,
  sortThreadsByUpdated,
  versionSections,
  type CommentGroups,
  type CommentSortOrder,
  type CommentThread,
} from "./artifact-comment-threads";
import { useFlash } from "./use-flash";
import { useCommentDrafts } from "./artifact-comment-drafts-context";
import { DraftList } from "./artifact-draft-group";
import { ArtifactPendingReview } from "./artifact-pending-review";
import { ReviewChip, ReviewComments, ReviewFilterMenu } from "./artifact-review-view";
import type { ReviewFilter } from "./use-review-filter";

const COMPACT_SEARCH_THRESHOLD = 5;

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
  const { focus, consumeFocus, prefill: activePrefill, consumePrefill } = useCommentRequests();
  const places = useCommentPlaces();
  const { query, comments } = list;
  const drafts = useCommentDrafts();
  const known = useKnownMentionables(artifactId);
  const plainMentions = useMemo(() => plainMentionsByHandle(known), [known]);
  const [replyTo, setReplyTo] = useState<CommentReplyTarget | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<CommentSortOrder>("page");
  const [flashId, flashThread] = useFlash<string>();
  const listElement = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activePrefill) setReplyTo(null);
  }, [activePrefill]);

  const searching = searchQuery.trim() !== "";
  const filteredGroups = useMemo(
    () => filterCommentGroups(groups, searchQuery),
    [groups, searchQuery],
  );
  const sections = useMemo(
    () =>
      versionSections(filteredGroups, shownVersion).map((section) => ({
        ...section,
        anchored: orderAnchored(
          section.anchored,
          [entryPath, ...filePaths],
          section.version === shownVersion ? places?.byId : undefined,
        ),
      })),
    [filteredGroups, shownVersion, entryPath, filePaths, places],
  );
  const updatedThreads = useMemo(
    () => sortThreadsByUpdated([...filteredGroups.whole, ...filteredGroups.anchored]),
    [filteredGroups],
  );
  const resolvedThreads = useMemo(
    () =>
      sortOrder === "updated"
        ? sortThreadsByUpdated(filteredGroups.resolved)
        : filteredGroups.resolved,
    [filteredGroups.resolved, sortOrder],
  );

  const titled = sections.some((section) => section.version !== shownVersion);
  const context: CommentContext = { artifactId, plainMentions, flashId, onReply: setReplyTo };
  const publishedThreadCount =
    groups.whole.length + groups.anchored.length + groups.resolved.length;
  const hasAnyPublished = publishedThreadCount > 0;
  const compactSearch = publishedThreadCount < COMPACT_SEARCH_THRESHOLD;
  const showSearchBar = !review.active && (!compactSearch || searchOpen || searching);
  const filteredEmpty = sections.length === 0 && resolvedThreads.length === 0;
  const showResolved = resolvedOpen || searching;

  useEffect(() => {
    const plan = planCommentFocus({
      focus,
      groups,
      filteredGroups,
      searching,
      resolvedOpen,
      reviewActive: review.active,
      pendingReview,
    });
    if (plan.action === "none") return;
    if (plan.action === "prepare") {
      if (plan.clearSearch) setSearchQuery("");
      if (plan.openResolved) setResolvedOpen(true);
      return;
    }
    const thread = listElement.current?.querySelector(
      `[data-comment-thread="${CSS.escape(plan.targetId)}"]`,
    );
    if (!thread) return;
    consumeFocus();
    thread.scrollIntoView({ block: "nearest" });
    flashThread(plan.targetId);
  }, [
    focus,
    groups,
    filteredGroups,
    searching,
    resolvedOpen,
    review.active,
    pendingReview,
    consumeFocus,
    flashThread,
  ]);

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
        {!review.active && compactSearch && (
          <ButtonUtility
            icon={SearchLg}
            size="xs"
            color="tertiary"
            tooltip={m.av_cm_search_placeholder()}
            aria-pressed={searchOpen || searching}
            data-comment-search-toggle=""
            className={cn((searchOpen || searching) && TOOLBAR_BUTTON_ON_CLASS)}
            onClick={() => {
              if (searchOpen && !searching) {
                setSearchOpen(false);
              } else {
                setSearchOpen(true);
                requestAnimationFrame(() => searchInputRef.current?.focus());
              }
            }}
          />
        )}
        {!review.active && <CommentSortMenu sortOrder={sortOrder} onChange={setSortOrder} />}
        <ReviewFilterMenu filter={review} />
      </ReviewPanelHeader>
      {showSearchBar && (
        <div className="shrink-0 border-b border-secondary px-3 py-2">
          <Input
            ref={searchInputRef}
            size="sm"
            icon={SearchLg}
            placeholder={m.av_cm_search_placeholder()}
            aria-label={m.av_cm_search_placeholder()}
            value={searchQuery}
            onChange={setSearchQuery}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (searchQuery) {
                event.preventDefault();
                event.stopPropagation();
                setSearchQuery("");
              } else if (searchOpen) {
                event.preventDefault();
                event.stopPropagation();
                setSearchOpen(false);
              }
            }}
          />
        </div>
      )}
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
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} size="card" />}
            title={m.av_cm_load_failed()}
            primaryAction={
              <RetryButton
                size="card"
                isRetrying={query.isRefetching}
                label={m.av_cm_retry()}
                onPress={() => void query.refetch()}
              />
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {!searching && drafts.drafts.length > 0 && (
              <section data-draft-group="" className="flex flex-col gap-2">
                <h3 className={SECTION_LABEL_CLASS}>{m.av_dr_group()}</h3>
                <DraftList
                  artifactId={artifactId}
                  comments={comments}
                  plainMentions={plainMentions}
                  refusal={null}
                />
              </section>
            )}
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
                  onPress={() => void query.fetchNextPage()}
                >
                  {query.isFetchNextPageError ? m.av_cm_retry() : m.av_cm_older()}
                </Button>
              </div>
            )}
            {filteredEmpty && !query.hasNextPage && (
              <EmptyState
                size="card"
                live={searching && hasAnyPublished ? "polite" : undefined}
                picture={
                  <EmptyIcon
                    icon={searching && hasAnyPublished ? SearchLg : MessageSquare01}
                    size="card"
                    muted={!(searching && hasAnyPublished)}
                  />
                }
                title={searching && hasAnyPublished ? m.av_cm_search_empty() : m.av_cm_empty()}
                primaryAction={
                  searching && hasAnyPublished ? (
                    <Button size="xs" color="tertiary" onPress={() => setSearchQuery("")}>
                      {m.ag_clear_search()}
                    </Button>
                  ) : undefined
                }
              />
            )}
            {sortOrder === "updated"
              ? updatedThreads.length > 0 && (
                  <ThreadGroup
                    threads={updatedThreads}
                    context={context}
                    shownVersion={shownVersion}
                  />
                )
              : sections.map((section) => (
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
                        shownVersion={shownVersion}
                      />
                    )}
                    {section.anchored.length > 0 && (
                      <ThreadGroup
                        threads={section.anchored}
                        context={context}
                        shownVersion={shownVersion}
                      />
                    )}
                  </section>
                ))}
            {resolvedThreads.length > 0 && (
              <section>
                <AriaButton
                  aria-expanded={showResolved}
                  className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md text-left text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:text-secondary focus-visible:outline-2"
                  onPress={() => setResolvedOpen((open) => !open)}
                >
                  {showResolved ? (
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                  )}
                  {m.av_cm_resolved_group({ count: resolvedThreads.length })}
                </AriaButton>
                {showResolved && (
                  <ul className="mt-2 flex flex-col gap-2">
                    {resolvedThreads.map((thread) => (
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
      <ArtifactCommentComposer
        artifactId={artifactId}
        target={
          replyTo
            ? { kind: "reply", ...replyTo, onCancel: () => setReplyTo(null) }
            : { kind: "panel", version: shownVersion }
        }
        prefill={activePrefill}
        onConsumePrefill={consumePrefill}
        onPosted={() => setReplyTo(null)}
      />
    </ArtifactSidePanel>
  );
}

function CommentSortMenu({
  sortOrder,
  onChange,
}: {
  sortOrder: CommentSortOrder;
  onChange: (next: CommentSortOrder) => void;
}) {
  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={SwitchVertical01}
        size="xs"
        color="tertiary"
        tooltip={m.av_cm_sort()}
        data-comment-sort=""
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={m.av_cm_sort()}
          selectionMode="single"
          selectedKeys={[sortOrder]}
          disallowEmptySelection
          onAction={(key) => {
            if (key === "page" || key === "updated") onChange(key);
          }}
        >
          <Dropdown.Item id="page" label={m.av_cm_sort_page()} />
          <Dropdown.Item id="updated" label={m.av_cm_sort_updated()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function ThreadGroup({
  title,
  threads,
  context,
  shownVersion,
}: {
  title?: string;
  threads: readonly CommentThread[];
  context: CommentContext;
  shownVersion: number;
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
            versionTag={thread.root.version !== shownVersion}
          />
        ))}
      </ul>
    </section>
  );
}
