import { useCallback, useState } from "react";

import type { CommentTarget } from "./artifact-commenting";
import { revealsInFrame } from "./artifact-page-annotations";
import { artifactKindOfPath } from "./artifact-path-kind";

type OpenedFile = { path: string; source: boolean };

export function framedKind(path: string, entryPath: string | undefined, source: boolean) {
  const kind = artifactKindOfPath(path);
  if (kind === "pdf") return kind;
  return kind === "html" && !source && path !== entryPath ? kind : null;
}

export function useOpenFile(entryPath: string | undefined, webPage: boolean) {
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const openFile = useCallback(
    (path: string | null) => setOpened(path === null ? null : { path, source: false }),
    [],
  );
  const openThread = useCallback(
    (target: CommentTarget) => {
      const kind = artifactKindOfPath(target.path);
      const html = kind === "html";
      const framed = html && revealsInFrame(target.anchor);
      const onEntry = target.path === entryPath;
      setOpened(
        onEntry && (framed ? webPage : !webPage)
          ? null
          : { path: target.path, source: html && !framed },
      );
      if (kind === "pdf") return false;
      return framed || !html || !onEntry || !webPage || target.anchor?.type === "lines";
    },
    [entryPath, webPage],
  );
  return {
    openPath: opened?.path ?? null,
    source: opened?.source ?? false,
    framesPage:
      opened === null ? webPage : framedKind(opened.path, entryPath, opened.source) === "html",
    openFile,
    openThread,
  };
}
