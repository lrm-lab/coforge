import { useLayoutEffect, useRef, type CSSProperties } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  consumeSharedRect,
  isRectInViewport,
} from "#src/lib/shared-element-rect";
import { ARTIFACT_TITLE_ID } from "./artifact-page-header";
import {
  ARTIFACT_FRAME_RECT_KEY,
  ARTIFACT_FRAME_VT_NAME,
  ARTIFACT_TITLE_RECT_KEY,
  supportsViewTransitions,
  useActiveArtifactTransitionId,
} from "./artifact-view-transition";

export function useArtifactPageTransition({
  artifactId,
  pane,
  phone,
}: {
  artifactId: string;
  pane: boolean;
  phone: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const activeTransitionId = useActiveArtifactTransitionId();
  const activeTransition = !pane && !reduced && activeTransitionId === artifactId;
  const frameRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (pane || reduced || supportsViewTransitions()) return;
    const frameOrigin = consumeSharedRect(ARTIFACT_FRAME_RECT_KEY);
    const titleOrigin = consumeSharedRect(ARTIFACT_TITLE_RECT_KEY);
    if (frameRef.current && frameOrigin && isRectInViewport(frameOrigin)) {
      animateFlipFromRect(frameRef.current, frameOrigin, {
        duration: phone ? 460 : 340,
        mode: "box",
        includeRadius: true,
      });
    }
    const titleEl = document.getElementById(ARTIFACT_TITLE_ID);
    if (titleEl && titleOrigin && isRectInViewport(titleOrigin)) {
      animateFlipFromRect(titleEl, titleOrigin, {
        duration: phone ? 460 : 340,
        mode: "uniform",
      });
    }
  }, [artifactId, pane, phone, reduced]);

  const frameStyle: CSSProperties | undefined = activeTransition
    ? { viewTransitionName: ARTIFACT_FRAME_VT_NAME }
    : undefined;

  return { frameRef, frameStyle };
}
