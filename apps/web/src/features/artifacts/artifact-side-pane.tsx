import { ArtifactDraftPane } from "./artifact-draft-pane";
import { ArtifactPage } from "./artifact-page";
import {
  closedArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

/**
 * The artifact open beside a conversation's chat: one saved (`doc`), or a new document not saved
 * yet (`docDraft`).
 */
export function ConversationArtifactPane({
  conversationId,
  search,
}: {
  conversationId: string;
  search: ArtifactSearch;
}) {
  const navigate = useArtifactNavigation();
  const pane = {
    full: Boolean(search.docFull),
    onToggleFull: () => navigate({ docFull: search.docFull ? undefined : true }, { replace: true }),
    onClose: () => navigate(closedArtifactSearch),
  };
  if (search.doc === undefined)
    return (
      <ArtifactDraftPane
        // A draft belongs to its conversation: another one starts its own.
        key={conversationId}
        conversationId={conversationId}
        search={search}
      />
    );
  return <ArtifactPage artifactId={search.doc} pane={pane} />;
}
