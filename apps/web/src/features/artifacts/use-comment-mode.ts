import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ArtifactPanelName = "files" | "comments" | "pending" | "locating";

export function nextPanelAfterCommentsToggle(
  panel: ArtifactPanelName | null,
): ArtifactPanelName | null {
  return panel === "comments" ? null : "comments";
}

export function useCommentMode(setPanel: Dispatch<SetStateAction<ArtifactPanelName | null>>) {
  const [mode, setMode] = useState(false);
  const toggleMode = useCallback(() => setMode((current) => !current), []);
  const exitMode = useCallback(() => setMode(false), []);
  const togglePanel = useCallback(
    () => setPanel((panel) => nextPanelAfterCommentsToggle(panel)),
    [setPanel],
  );
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  return { mode, toggleMode, exitMode, togglePanel, closePanel };
}
