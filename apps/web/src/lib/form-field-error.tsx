import type { ReactNode } from "react";

export function fieldHint(error: string | undefined, hint?: ReactNode): ReactNode {
  return error ? <span role="alert">{error}</span> : hint;
}

const FOCUSABLE_SELECTOR =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isHiddenInput(element: Element): boolean {
  return element.tagName === "INPUT" && (element as HTMLInputElement).type === "hidden";
}

function resolveFocusable(target: Element): HTMLElement | null {
  if (!isHiddenInput(target) && typeof (target as HTMLElement).focus === "function") {
    const htmlTarget = target as HTMLElement;
    const isNativeControl =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "BUTTON" ||
      target.tagName === "SELECT";
    if (isNativeControl || htmlTarget.tabIndex >= 0) return htmlTarget;
  }
  const ownNested = target.querySelector?.(FOCUSABLE_SELECTOR);
  if (ownNested && typeof (ownNested as HTMLElement).focus === "function") {
    return ownNested as HTMLElement;
  }
  const wrapper =
    target.closest?.("[data-input-wrapper], [data-field-group], [role='group']") ??
    target.parentElement;
  const nested = wrapper?.querySelector?.(FOCUSABLE_SELECTOR);
  if (nested && typeof (nested as HTMLElement).focus === "function") {
    return nested as HTMLElement;
  }
  return null;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function focusFirstInvalidField(container: ParentNode | null, fieldName?: string): boolean {
  if (!container) return false;
  let candidate: Element | null = null;
  if (fieldName) {
    const escaped = escapeAttrValue(fieldName);
    candidate =
      container.querySelector(`[data-field="${escaped}"]`) ??
      container.querySelector(`[name="${escaped}"]:not([type="hidden"])`) ??
      container.querySelector(`[name="${escaped}"]`);
  }
  if (!candidate) {
    candidate = container.querySelector('[aria-invalid="true"], [data-invalid="true"]');
  }
  if (!candidate) return false;
  const target = resolveFocusable(candidate);
  if (!target) return false;
  target.scrollIntoView?.({
    block: "center",
    inline: "nearest",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  target.focus({ preventScroll: true });
  return true;
}

export function scheduleFocusInvalidField(container: ParentNode | null, fieldName?: string): void {
  if (!container) return;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      focusFirstInvalidField(container, fieldName);
    });
    return;
  }
  focusFirstInvalidField(container, fieldName);
}
