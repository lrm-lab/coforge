import { Button as AriaButton, ToggleButton } from "react-aria-components";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ConversationFilesPanel } from "#src/features/conversations/conversation-files";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactActor, ArtifactIcon, useArtifactTime, versionLabel } from "./artifact-parts";
import { artifactListQuery, useArtifactActor, type ArtifactCard } from "./artifact-queries";
import { draftArtifactSearch, openArtifactSearch, useArtifactNavigation } from "./artifact-search";

type Filter = "all" | "docs" | "files";

/**
 * A conversation's Files tab with its documents (task #385, Frank: no Documents entry in the
 * navigation; documents live with the conversation's files): All / Documents / Files, a new
 * document for a member, the documents (most recently changed first) above the files.
 */
export function ConversationFilesWithDocuments({
  conversationId,
  canCreate,
  onOpenMessage,
}: {
  conversationId: string;
  canCreate: boolean;
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const documents = useQuery(artifactListQuery(conversationId));
  const count = documents.data?.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-4 md:px-6">
        <div role="group" aria-label={m.doc_filter_label()} className="flex items-center gap-1">
          <FilterChip on={filter === "all"} onClick={() => setFilter("all")}>
            {m.doc_filter_all()}
          </FilterChip>
          <FilterChip on={filter === "docs"} onClick={() => setFilter("docs")}>
            {m.doc_filter_docs()}
            {count ? <span className="text-tertiary"> {count}</span> : null}
          </FilterChip>
          <FilterChip on={filter === "files"} onClick={() => setFilter("files")}>
            {m.doc_filter_files()}
          </FilterChip>
        </div>
        <span className="flex-1" />
        {canCreate && <NewDocumentButton />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {filter !== "files" && (
          <DocumentList documents={documents} onlyDocuments={filter === "docs"} />
        )}
        {filter !== "docs" && (
          <ConversationFilesPanel conversationId={conversationId} onOpenMessage={onOpenMessage} />
        )}
      </div>
    </div>
  );
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

/** Opens a new document as a draft: it is created on its first save (`ArtifactDraftPane`). */
function NewDocumentButton() {
  const navigate = useArtifactNavigation();
  return (
    <Button
      size="sm"
      color="primary"
      iconLeading={Plus}
      onClick={() => navigate(draftArtifactSearch)}
    >
      {m.doc_new()}
    </Button>
  );
}

function DocumentList({
  documents,
  onlyDocuments,
}: {
  documents: ReturnType<typeof useQuery<ArtifactCard[]>>;
  onlyDocuments: boolean;
}) {
  if (documents.isPending) return null;
  if (documents.isError)
    return <p className="px-4 pt-3 text-sm text-error-primary md:px-6">{m.doc_list_failed()}</p>;
  if (documents.data.length === 0)
    return onlyDocuments ? (
      <p className="px-4 pt-4 text-sm text-tertiary md:px-6">{m.doc_list_empty()}</p>
    ) : null;
  return (
    <ul aria-label={m.doc_filter_docs()} className="flex flex-col gap-2 px-4 pt-4 md:px-6">
      {documents.data.map((card) => (
        <DocumentRow key={card.id} card={card} />
      ))}
    </ul>
  );
}

function DocumentRow({ card }: { card: ArtifactCard }) {
  const navigate = useArtifactNavigation();
  const actorOf = useArtifactActor();
  const time = useArtifactTime();
  return (
    <li>
      <AriaButton
        onPress={() => navigate(openArtifactSearch(card.id))}
        className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-secondary bg-primary py-2 pr-3 pl-3 text-left outline-focus-ring hover:bg-primary_hover data-focus-visible:outline-2"
      >
        <ArtifactIcon />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-primary">
            {card.title || m.doc_untitled()}
          </span>
          <span className="truncate text-xs text-tertiary">
            {card.preview.replace(/\n/g, " · ") || versionLabel(card.currentVersion)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-tertiary max-sm:hidden">
          <ArtifactActor actor={actorOf(card.author)} />
          <span aria-hidden="true">·</span>
          {time(card.updatedAt)}
        </span>
        <span className="w-14 shrink-0 text-right text-xs text-tertiary">
          {card.currentVersion > 0 ? versionLabel(card.currentVersion) : ""}
        </span>
      </AriaButton>
    </li>
  );
}
