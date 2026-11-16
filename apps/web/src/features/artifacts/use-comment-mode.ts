import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ArtifactPanelName = "files" | "comments";

export function useCommentMode(setPanel: Dispatch<SetStateAction<ArtifactPanelName | null>>) {
  const [mode, setMode] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const toggle = useCallback(() => {
    if (mode) {
      setMode(false);
      setPanel((open) => (open === "comments" ? null : open));
      return;
    }
    setMode(true);
    setPanel("comments");
    setFocusRequest((count) => count + 1);
  }, [mode, setPanel]);
  const showAll = useCallback(() => setPanel("comments"), [setPanel]);
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  return { mode, focusRequest, toggle, showAll, closePanel };
}
