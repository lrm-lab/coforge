export type SharedRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: string;
};

type StoredEntry = {
  rect: SharedRect;
  at: number;
  element?: WeakRef<Element>;
};

export const CONTINUOUS_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
export const CONTINUOUS_EASE_TUPLE = [0.32, 0.72, 0, 1] as const;

const ENTRY_TTL_MS = 4000;
const store = new Map<string, StoredEntry>();
const activeAnimations = new WeakMap<HTMLElement, Animation>();

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isRectInViewport(
  rect: Pick<SharedRect, "top" | "left" | "width" | "height">,
): boolean {
  if (typeof window === "undefined") return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const bottom = rect.top + rect.height;
  const right = rect.left + rect.width;
  return bottom > 0 && right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export function captureElementRect(element: Element | null | undefined): SharedRect | null {
  if (!element || typeof window === "undefined") return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const computed = window.getComputedStyle(element);
  return {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    radius: computed.borderRadius || "0px",
  };
}

export function rememberSharedRect(
  key: string,
  element: Element | null | undefined,
): SharedRect | null {
  const rect = captureElementRect(element);
  if (!rect) return null;
  store.set(key, {
    rect,
    at: Date.now(),
    element: element && typeof WeakRef !== "undefined" ? new WeakRef(element) : undefined,
  });
  return rect;
}

export function peekSharedRect(key: string): SharedRect | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ENTRY_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.rect;
}

export function consumeSharedRect(key: string): SharedRect | null {
  const rect = peekSharedRect(key);
  store.delete(key);
  return rect;
}

export function measureRememberedElement(key: string): SharedRect | null {
  const entry = store.get(key);
  if (!entry) return null;
  const live = entry.element?.deref();
  if (live && live.isConnected) {
    const fresh = captureElementRect(live);
    if (fresh && isRectInViewport(fresh)) return fresh;
    return null;
  }
  return isRectInViewport(entry.rect) ? entry.rect : null;
}

export function clearSharedRect(key: string): void {
  store.delete(key);
}

export function computeFlipTransform(
  from: Pick<SharedRect, "top" | "left" | "width" | "height">,
  to: Pick<SharedRect, "top" | "left" | "width" | "height">,
  mode: "box" | "uniform" = "box",
): string | null {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return null;
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;
  const toCx = to.left + to.width / 2;
  const toCy = to.top + to.height / 2;
  const dx = fromCx - toCx;
  const dy = fromCy - toCy;
  const rawSx = from.width / to.width;
  const rawSy = from.height / to.height;
  if (mode === "uniform") {
    const s = Math.max(0.05, Math.min(rawSx, rawSy));
    return `translate3d(${dx}px, ${dy}px, 0) scale(${s})`;
  }
  const sx = Math.max(0.05, rawSx);
  const sy = Math.max(0.05, rawSy);
  return `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`;
}

export function cancelFlipAnimation(target: HTMLElement | null | undefined): void {
  if (!target) return;
  activeAnimations.get(target)?.cancel();
  activeAnimations.delete(target);
}

export function animateFlipFromRect(
  target: HTMLElement,
  from: SharedRect,
  options: {
    duration: number;
    easing?: string;
    mode?: "box" | "uniform";
    includeRadius?: boolean;
  },
): Animation | null {
  if (prefersReducedMotion() || typeof target.animate !== "function") return null;
  cancelFlipAnimation(target);
  const to = captureElementRect(target);
  if (!to) return null;
  const inverse = computeFlipTransform(from, to, options.mode ?? "box");
  if (!inverse) return null;
  const startFrame: Keyframe = { transform: inverse };
  const endFrame: Keyframe = { transform: "translate3d(0, 0, 0) scale(1)" };
  if (options.includeRadius) {
    startFrame.borderRadius = from.radius;
    endFrame.borderRadius = to.radius;
  }
  const animation = target.animate([startFrame, endFrame], {
    duration: options.duration,
    easing: options.easing ?? CONTINUOUS_EASING,
  });
  activeAnimations.set(target, animation);
  animation.addEventListener("finish", () => {
    if (activeAnimations.get(target) === animation) activeAnimations.delete(target);
  });
  animation.addEventListener("cancel", () => {
    if (activeAnimations.get(target) === animation) activeAnimations.delete(target);
  });
  return animation;
}

export function animateFlipToRect(
  target: HTMLElement,
  to: SharedRect,
  options: {
    duration: number;
    easing?: string;
    mode?: "box" | "uniform";
    includeRadius?: boolean;
    fromTransform?: string;
  },
): Animation | null {
  if (prefersReducedMotion() || typeof target.animate !== "function") return null;
  cancelFlipAnimation(target);
  const current = captureElementRect(target);
  if (!current) return null;
  const delta = computeFlipTransform(to, current, options.mode ?? "box");
  if (!delta) return null;
  const startFrame: Keyframe = {
    transform: options.fromTransform ?? "translate3d(0, 0, 0) scale(1)",
  };
  const endFrame: Keyframe = { transform: delta };
  if (options.includeRadius) {
    startFrame.borderRadius = current.radius;
    endFrame.borderRadius = to.radius;
  }
  const animation = target.animate([startFrame, endFrame], {
    duration: options.duration,
    easing: options.easing ?? CONTINUOUS_EASING,
    fill: "forwards",
  });
  activeAnimations.set(target, animation);
  return animation;
}
