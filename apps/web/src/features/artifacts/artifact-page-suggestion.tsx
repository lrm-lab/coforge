import { useEffect, useRef, useState, type RefObject } from "react";

import { ArtifactCommentPopover } from "./artifact-comment-popover";
import { useCommentDrafts } from "./artifact-comment-drafts-context";
import type { CommentAnchor } from "./artifact-comment-inputs";
import { useArtifactCommenting } from "./artifact-commenting";
import type { PageSuggestHandler } from "./artifact-page-bridge";
import { POPOVER_WIDTH_PX, clampWithin } from "./use-anchor-draft";

const TOP_PX = 16;

type Suggested = {
  version: number;
  anchor: CommentAnchor;
  draft: string | undefined;
  left: number;
};

export function PageSuggestion({
  path,
  suggestions,
  container,
  composing,
}: {
  path: string;
  suggestions: RefObject<PageSuggestHandler | null>;
  container: RefObject<HTMLDivElement | null>;
  composing: RefObject<boolean>;
}) {
  const { artifactId, version, holds } = useArtifactCommenting();
  const drafts = useCommentDrafts();
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  const shown = suggested?.version === version ? suggested : null;
  const latest = useRef({ version, busy: false });
  latest.current = {
    version,
    busy: shown !== null || drafts.busy || drafts.submitting || drafts.pending.open,
  };

  useEffect(() => {
    suggestions.current = (request) => {
      if (latest.current.busy || composing.current || holds.any()) return false;
      latest.current.busy = true;
      const width = container.current?.getBoundingClientRect().width ?? 0;
      setSuggested({
        version: latest.current.version,
        anchor: { type: "page", data: request.anchor },
        draft: request.draft,
        left: clampWithin((width - POPOVER_WIDTH_PX) / 2, width, POPOVER_WIDTH_PX),
      });
      return true;
    };
    return () => {
      suggestions.current = null;
    };
  }, [suggestions, container, composing, holds]);

  if (!shown) return null;
  return (
    <ArtifactCommentPopover
      artifactId={artifactId}
      version={shown.version}
      path={path}
      anchor={shown.anchor}
      suggestion={shown.draft}
      top={TOP_PX}
      left={shown.left}
      onClose={() => setSuggested(null)}
    />
  );
}
