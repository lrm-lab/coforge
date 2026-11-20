import { ArtifactPage } from "./artifact-page";
import {
  closedArtifactSearch,
  openArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

export function ConversationArtifactPane({
  conversationId,
  search,
}: {
  conversationId?: string;
  search: ArtifactSearch;
}) {
  const navigate = useArtifactNavigation();
  if (search.doc === undefined) return null;
  const pane = {
    full: Boolean(search.docFull),
    onToggleFull: () => navigate({ docFull: search.docFull ? undefined : true }, { replace: true }),
    onClose: () => navigate(closedArtifactSearch),
    conversationId,
    onSwitchArtifact: (artifactId: string) =>
      navigate(openArtifactSearch(artifactId), { replace: true }),
  };
  return <ArtifactPage artifactId={search.doc} pane={pane} />;
}
