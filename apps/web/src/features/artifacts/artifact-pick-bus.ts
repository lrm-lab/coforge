import type { CommentAnchor } from "./artifact-comment-inputs";

export type PickedElementRef = {
  path: string;
  tag: string;
  selector: string;
  quote?: string;
};

type PickHandler = (picked: PickedElementRef) => void;
type HighlightListener = (anchors: readonly CommentAnchor[]) => void;

export type ArtifactPickBus = ReturnType<typeof createArtifactPickBus>;

export function createArtifactPickBus() {
  let pickHandler: PickHandler | null = null;
  let highlighted: readonly CommentAnchor[] = [];
  const highlightListeners = new Set<HighlightListener>();

  return {
    setPickHandler(handler: PickHandler | null) {
      pickHandler = handler;
    },
    emitPick(picked: PickedElementRef): boolean {
      if (!pickHandler) return false;
      pickHandler(picked);
      return true;
    },
    setHighlightedAnchors(anchors: readonly CommentAnchor[]) {
      highlighted = anchors;
      highlightListeners.forEach((listener) => listener(highlighted));
    },
    subscribeHighlightedAnchors(listener: HighlightListener) {
      highlightListeners.add(listener);
      listener(highlighted);
      return () => {
        highlightListeners.delete(listener);
      };
    },
  };
}
