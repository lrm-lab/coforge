import { useSyncExternalStore } from "react";

import { prefersReducedMotion, rememberSharedRect } from "#src/lib/shared-element-rect";

export const ARTIFACT_FRAME_VT_NAME = "artifact-frame";
export const ARTIFACT_TITLE_VT_NAME = "artifact-title";
export const ARTIFACT_FRAME_RECT_KEY = "artifact-page-frame";
export const ARTIFACT_TITLE_RECT_KEY = "artifact-page-title";

type Listener = () => void;

type TaggedElements = {
  frame?: HTMLElement | null;
  title?: HTMLElement | null;
};

const CLEANUP_DELAY_MS = 900;
const BACK_SETTLE_TIMEOUT_MS = 600;

let activeArtifactId: string | null = null;
let taggedElements: HTMLElement[] = [];
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function clearTaggedStyles() {
  for (const el of taggedElements) {
    el.style.viewTransitionName = "";
  }
  taggedElements = [];
}

function scheduleCleanup(delayMs = CLEANUP_DELAY_MS) {
  if (cleanupTimer !== null) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    clearArtifactViewTransition();
  }, delayMs);
}

export function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as Document & { startViewTransition?: unknown }).startViewTransition ===
      "function"
  );
}

export function getActiveArtifactTransitionId(): string | null {
  return activeArtifactId;
}

export function subscribeArtifactTransition(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActiveArtifactTransitionId(): string | null {
  return useSyncExternalStore(
    subscribeArtifactTransition,
    getActiveArtifactTransitionId,
    () => null,
  );
}

export function prepareArtifactViewTransition(
  artifactId: string,
  elements: TaggedElements = {},
): void {
  clearTaggedStyles();
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  activeArtifactId = artifactId;

  if (!prefersReducedMotion()) {
    if (elements.frame) {
      rememberSharedRect(ARTIFACT_FRAME_RECT_KEY, elements.frame);
      if (supportsViewTransitions()) {
        elements.frame.style.viewTransitionName = ARTIFACT_FRAME_VT_NAME;
        taggedElements.push(elements.frame);
      }
    }
    if (elements.title) {
      rememberSharedRect(ARTIFACT_TITLE_RECT_KEY, elements.title);
      if (supportsViewTransitions()) {
        elements.title.style.viewTransitionName = ARTIFACT_TITLE_VT_NAME;
        taggedElements.push(elements.title);
      }
    }
  }

  emit();
  scheduleCleanup();
}

export function clearArtifactViewTransition(): void {
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  clearTaggedStyles();
  if (activeArtifactId === null) return;
  activeArtifactId = null;
  emit();
}

type RouterWithBack = {
  history: { back: () => void };
  subscribe: (event: "onResolved", listener: () => void) => () => void;
};

type DocumentWithViewTransition = Document & {
  startViewTransition: (cb: () => Promise<void> | void) => { finished: Promise<void> };
};

export function runArtifactBackViewTransition(
  router: RouterWithBack,
  artifactId: string,
  elements: TaggedElements = {},
): void {
  if (prefersReducedMotion() || !supportsViewTransitions()) {
    router.history.back();
    return;
  }

  prepareArtifactViewTransition(artifactId, elements);

  const doc = document as DocumentWithViewTransition;
  const transition = doc.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe?.();
          unsubscribe = null;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
          } else {
            resolve();
          }
        };
        const timeout = setTimeout(finish, BACK_SETTLE_TIMEOUT_MS);
        unsubscribe = router.subscribe("onResolved", finish);
        router.history.back();
      }),
  );

  void transition.finished.finally(() => {
    clearArtifactViewTransition();
  });
}
