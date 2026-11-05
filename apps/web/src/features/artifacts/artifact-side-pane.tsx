import { ArtifactDraftPane } from "./artifact-draft-pane";
import { ArtifactPage } from "./artifact-page";
import {
  closedArtifactSearch,
  useArtifactNavigation,
  type ArtifactPageSearch,
  type ArtifactSearch,
} from "./artifact-search";

/**
 * The artifact open beside a conversation's chat: one saved (`doc`), with its version and
 * history on the conversation's address, or a new document not saved yet (`docDraft`).
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
  const onNavigate = (patch: ArtifactPageSearch) =>
    navigate(
      {
        ...("version" in patch && { docVersion: patch.version }),
        ...("history" in patch && { docHistory: patch.history }),
      },
      { replace: true },
    );
  return (
    <ArtifactPage
      artifactId={search.doc}
      search={{ version: search.docVersion, history: search.docHistory }}
      pane={{ ...pane, onNavigate }}
    />
  );
}
