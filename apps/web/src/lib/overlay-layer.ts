import { useCallback, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { flushSync } from "react-dom";

export const OVERLAY_LAYER = "z-50";

export const OVERLAY_SCRIM_Z = 0;
export const OVERLAY_CONTENT_Z = 10;

export function createOverlayHostElement(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("data-overlay-host", "");
  host.className = `absolute inset-x-0 top-0 ${OVERLAY_LAYER}`;
  return host;
}

export function composeOverlayRefs<T>(
  externalRef: Ref<T> | undefined,
  internalRef: (node: T | null) => void,
): (node: T | null) => void {
  return (node) => {
    internalRef(node);
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef) externalRef.current = node;
  };
}

export function useOverlayHost(
  open: boolean,
  pageFlow = false,
): {
  host: HTMLDivElement | null;
  overlayRef: (node: HTMLElement | null) => void;
} {
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === "undefined" ? null : createOverlayHostElement(),
  );
  const [overlayMounted, setOverlayMounted] = useState(false);

  const overlayRef = useCallback((node: HTMLElement | null) => {
    setOverlayMounted(node !== null);
  }, []);

  const active = open || overlayMounted;

  useLayoutEffect(() => {
    if (!host) return;
    host.className = pageFlow
      ? `relative ${OVERLAY_LAYER}`
      : `absolute inset-x-0 top-0 ${OVERLAY_LAYER}`;
  }, [host, pageFlow]);

  useLayoutEffect(() => {
    if (!host || !active) return;
    if (!host.isConnected) document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host, active]);

  useLayoutEffect(() => {
    if (!host || !open) return;
    if (!host.isConnected || host.nextSibling !== null) document.body.appendChild(host);
  }, [host, open]);

  return { host, overlayRef };
}

type OverlayAnimationHandler = (element: HTMLElement) => void | Promise<void>;

function useOverlayAnimation(
  ref: RefObject<HTMLElement | null>,
  isActive: boolean,
  onStart: OverlayAnimationHandler | undefined,
  onEnd: () => void,
) {
  const isActiveRef = useRef<boolean | null>(null);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  useLayoutEffect(() => {
    const element = ref.current;
    if (isActive && element && isActiveRef.current !== isActive) {
      isActiveRef.current = isActive;
      if (!("getAnimations" in element)) {
        onEnd();
        return;
      }
      const startPromise = onStartRef.current?.(element);
      const animations = element
        .getAnimations()
        .filter(
          (animation) =>
            (typeof DocumentTimeline === "undefined" ||
              animation.timeline instanceof DocumentTimeline) &&
            animation.playState === "running",
        );
      if (animations.length === 0 && !startPromise) {
        onEnd();
        return;
      }
      let cancelled = false;
      const finish = () => {
        if (cancelled) return;
        flushSync(() => {
          onEnd();
        });
      };
      void Promise.all([startPromise, ...animations.map((animation) => animation.finished)]).then(
        finish,
        finish,
      );
      return () => {
        cancelled = true;
        if (isActiveRef.current === true) {
          isActiveRef.current = null;
        }
      };
    }
    isActiveRef.current = isActive;
  }, [ref, isActive, onEnd]);
}

export function useOverlayEnterAnimation(
  ref: RefObject<HTMLElement | null>,
  isReady = true,
  onEnter?: OverlayAnimationHandler,
): boolean {
  const [isEntering, setEntering] = useState(true);
  const isAnimationReady = isEntering && isReady;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!isReady && element) {
      const prevOpacity = element.style.opacity;
      element.style.opacity = "0";
      return () => {
        element.style.opacity = prevOpacity;
      };
    }
  }, [ref, isReady]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (isAnimationReady && element && "getAnimations" in element) {
      for (const animation of element.getAnimations()) {
        if (animation instanceof CSSTransition) {
          animation.cancel();
        }
      }
    }
  }, [ref, isAnimationReady]);

  const finishEnter = useCallback(() => setEntering(false), []);
  useOverlayAnimation(ref, isAnimationReady, onEnter, finishEnter);
  return isAnimationReady;
}

export function useOverlayExitAnimation(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onExit?: OverlayAnimationHandler,
): boolean {
  const [exitState, setExitState] = useState<"closed" | "open" | "exiting">(
    isOpen ? "open" : "closed",
  );

  if (exitState === "open" && !isOpen) {
    setExitState("exiting");
  } else if (exitState !== "open" && isOpen) {
    setExitState("open");
  }

  const isExiting = exitState === "exiting";
  const finishExit = useCallback(() => {
    setExitState((state) => (state === "exiting" ? "closed" : state));
  }, []);
  useOverlayAnimation(ref, isExiting, onExit, finishExit);
  return isExiting;
}
