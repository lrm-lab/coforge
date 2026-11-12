import { ArtifactPage } from "./artifact-page";
import {
  closedArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

/** The artifact open beside a conversation's chat (`doc`). */
export function ConversationArtifactPane({ search }: { search: ArtifactSearch }) {
  const navigate = useArtifactNavigation();
  if (search.doc === undefined) return null;
  const pane = {
    full: Boolean(search.docFull),
    onToggleFull: () => navigate({ docFull: search.docFull ? undefined : true }, { replace: true }),
    onClose: () => navigate(closedArtifactSearch),
  };
  return <ArtifactPage artifactId={search.doc} pane={pane} />;
}
