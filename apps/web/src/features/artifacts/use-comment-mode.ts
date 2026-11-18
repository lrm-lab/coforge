import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ArtifactPanelName = "files" | "comments";

export function useCommentMode(
  setPanel: Dispatch<SetStateAction<ArtifactPanelName | null>>,
  docked: boolean,
) {
  const [mode, setMode] = useState(false);
  const toggle = useCallback(() => {
    const next = !mode;
    setMode(next);
    setPanel((panel) =>
      next ? (docked ? "comments" : panel) : panel === "comments" ? null : panel,
    );
  }, [mode, docked, setPanel]);
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  return { mode, toggle, closePanel };
}
