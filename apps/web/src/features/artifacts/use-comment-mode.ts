import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ArtifactPanelName = "files" | "comments";

export function nextPanelAfterToggle(
  panel: ArtifactPanelName | null,
  nextMode: boolean,
): ArtifactPanelName | null {
  return nextMode ? "comments" : panel === "comments" ? null : panel;
}

export function useCommentMode(setPanel: Dispatch<SetStateAction<ArtifactPanelName | null>>) {
  const [mode, setMode] = useState(false);
  const toggle = useCallback(() => {
    const next = !mode;
    setMode(next);
    setPanel((panel) => nextPanelAfterToggle(panel, next));
  }, [mode, setPanel]);
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  return { mode, toggle, closePanel };
}
