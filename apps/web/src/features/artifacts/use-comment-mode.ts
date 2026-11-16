import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ArtifactPanelName = "files" | "comments";

export function useCommentMode(setPanel: Dispatch<SetStateAction<ArtifactPanelName | null>>) {
  const [mode, setMode] = useState(false);
  const toggle = useCallback(() => setMode((on) => !on), []);
  const showAll = useCallback(() => setPanel("comments"), [setPanel]);
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  return { mode, toggle, showAll, closePanel };
}
