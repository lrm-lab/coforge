import { ToggleButton } from "react-aria-components";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { CircleAlert } from "kubai-icons/duotone";

import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { GalleryWireframe } from "#src/components/ui/empty-wireframes";
import {
  ConversationFilesPanel,
  conversationFilesQuery,
} from "#src/features/conversations/conversation-files";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactEditedLine, ArtifactIcon, kindLabel, useArtifactTime } from "./artifact-parts";
import { artifactListQuery, useArtifactActor, type ArtifactCard } from "./artifact-queries";
import { useArtifactLink } from "./artifact-beside-chat";

type Filter = "all" | "files" | "artifacts";

export function ConversationFilesWithDocuments({
  conversationId,
  onOpenMessage,
}: {
  conversationId: string;
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const artifacts = useQuery(artifactListQuery(conversationId));
  const files = useQuery(conversationFilesQuery(conversationId));
  const all = filter === "all";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-4 md:px-6">
        <div role="group" aria-label={m.doc_filter_label()} className="flex items-center gap-1">
          <FilterChip on={all} onClick={() => setFilter("all")}>
            {m.doc_filter_all()}
          </FilterChip>
          <FilterChip on={filter === "files"} onClick={() => setFilter("files")}>
            {m.doc_filter_files()}
            <Count of={files.data?.length} />
          </FilterChip>
          <FilterChip on={filter === "artifacts"} onClick={() => setFilter("artifacts")}>
            {m.doc_filter_artifacts()}
            <Count of={artifacts.data?.length} />
          </FilterChip>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
        {filter !== "files" && <ArtifactList artifacts={artifacts} heading={all} />}
        {filter !== "artifacts" && (
          <section aria-label={m.doc_filter_files()} className="flex flex-col">
            {all && artifacts.data?.length ? (
              <GroupHeading>{m.doc_filter_files()}</GroupHeading>
            ) : null}
            <ConversationFilesPanel conversationId={conversationId} onOpenMessage={onOpenMessage} />
          </section>
        )}
      </div>
    </div>
  );
}

function Count({ of }: { of: number | undefined }) {
  return of ? <span className="text-tertiary"> {of}</span> : null;
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-4 pt-5 text-xs font-medium text-tertiary md:px-6">{children}</h3>;
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <ToggleButton
      isSelected={on}
      onChange={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-sm font-medium outline-focus-ring data-focus-visible:outline-2",
        on ? "bg-active text-primary" : "text-tertiary hover:bg-primary_hover hover:text-secondary",
      )}
    >
      {children}
    </ToggleButton>
  );
}

function ArtifactList({
  artifacts,
  heading,
}: {
  artifacts: ReturnType<typeof useQuery<ArtifactCard[]>>;
  heading: boolean;
}) {
  if (artifacts.isPending) return null;
  if (artifacts.isError) {
    return (
      <div className="px-4 pt-3 md:px-6">
        <EmptyState
          size="card"
          role="alert"
          picture={<EmptyIcon icon={CircleAlert} size="card" />}
          title={m.doc_list_failed()}
          primaryAction={
            <RetryButton
              size="card"
              isRetrying={artifacts.isRefetching}
              onPress={() => void artifacts.refetch()}
            />
          }
        />
      </div>
    );
  }
  if (artifacts.data.length === 0) {
    return heading ? null : (
      <EmptyState
        picture={<GalleryWireframe accent={false} />}
        title={m.doc_list_empty()}
        description={m.empty_artifacts_description()}
      />
    );
  }
  return (
    <section aria-label={m.doc_filter_artifacts()} className="flex flex-col">
      {heading && <GroupHeading>{m.doc_filter_artifacts()}</GroupHeading>}
      <ul className={cn("flex flex-col gap-2 px-4 md:px-6", heading ? "pt-2" : "pt-4")}>
        {artifacts.data.map((card) => (
          <ArtifactRow key={card.id} card={card} />
        ))}
      </ul>
    </section>
  );
}

function ArtifactRow({ card }: { card: ArtifactCard }) {
  const linkTo = useArtifactLink();
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  return (
    <li>
      <Link
        {...linkTo(card.id)}
        className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-secondary bg-primary p-3 text-left outline-focus-ring hover:border-primary hover:bg-primary_hover focus-visible:outline-2"
      >
        <ArtifactIcon entryPath={card.entryPath} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-primary">
              {card.title || m.doc_untitled()}
            </span>
            <span className="shrink-0 text-xs text-quaternary">{kindLabel(card.entryPath)}</span>
          </span>
          <ArtifactEditedLine actor={actorOf(card.author)} time={time(card.updatedAt)} />
        </span>
      </Link>
    </li>
  );
}
