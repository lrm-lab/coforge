import { useEffect } from "react";
import { shouldExitOnEscape } from "#src/features/conversations/conversation-focus-model";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
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
  useEffect(() => {
    if (!search.docFull) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldExitOnEscape(event, () => document.querySelector(OPEN_OVERLAY_SELECTOR) !== null))
        return;
      event.preventDefault();
      navigate({ docFull: undefined }, { replace: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, search.docFull]);
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
