import { useEffect } from "react";
import { prefersReducedMotion } from "#src/lib/shared-element-rect";

const LIST_SELECTOR = '.coforge-popover [role="menu"], .coforge-popover [role="listbox"]';
const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';

function findHighlightTarget(item: HTMLElement): HTMLElement {
  const inner = item.firstElementChild;
  if (inner instanceof HTMLElement) {
    const rect = inner.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return inner;
  }
  return item;
}

function positionHighlight(list: HTMLElement, item: HTMLElement) {
  if (item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")) return;
  const target = findHighlightTarget(item);
  const listRect = list.getBoundingClientRect();
  const itemRect = target.getBoundingClientRect();
  if (itemRect.width <= 0 || itemRect.height <= 0) return;

  const x = itemRect.left - listRect.left + list.scrollLeft;
  const y = itemRect.top - listRect.top + list.scrollTop;
  const wasActive = list.dataset.slidingHl === "active";

  if (!wasActive) list.dataset.slidingHl = "snap";
  list.style.setProperty("--hl-x", `${x}px`);
  list.style.setProperty("--hl-y", `${y}px`);
  list.style.setProperty("--hl-w", `${itemRect.width}px`);
  list.style.setProperty("--hl-h", `${itemRect.height}px`);
  list.style.setProperty("--hl-o", "1");

  if (!wasActive) {
    requestAnimationFrame(() => {
      if (list.isConnected && list.dataset.slidingHl === "snap") {
        list.dataset.slidingHl = "active";
      }
    });
  }
}

function hideHighlight(list: HTMLElement) {
  list.style.setProperty("--hl-o", "0");
  delete list.dataset.slidingHl;
}

export function installMenuHighlight(): () => void {
  let activeList: HTMLElement | null = null;
  let activeItem: HTMLElement | null = null;

  const updateFromTarget = (target: EventTarget | null) => {
    if (prefersReducedMotion()) return;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>(ITEM_SELECTOR);
    if (!item) return;
    if (
      item.dataset.cascadeState === "skipped" ||
      item.closest("[data-cascade-menu], [data-no-sliding-hl]")
    )
      return;
    const list = item.closest<HTMLElement>(LIST_SELECTOR);
    if (!list) return;
    if (activeList && activeList !== list) hideHighlight(activeList);
    activeList = list;
    if (activeItem === item && list.dataset.slidingHl === "active") return;
    activeItem = item;
    positionHighlight(list, item);
  };

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    updateFromTarget(event.target);
  };

  const onFocusIn = (event: FocusEvent) => {
    updateFromTarget(event.target);
  };

  const onPointerOut = (event: PointerEvent) => {
    if (!activeList) return;
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (next && activeList.contains(next)) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && activeList.contains(focused)) {
      const focusedItem = focused.closest<HTMLElement>(ITEM_SELECTOR);
      if (focusedItem) {
        activeItem = focusedItem;
        positionHighlight(activeList, focusedItem);
        return;
      }
    }
    hideHighlight(activeList);
    activeList = null;
    activeItem = null;
  };

  const onFocusOut = (event: FocusEvent) => {
    if (!activeList) return;
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (next && activeList.contains(next)) return;
    hideHighlight(activeList);
    activeList = null;
    activeItem = null;
  };

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);

  return () => {
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
  };
}

export function MenuHighlightTracker() {
  useEffect(() => installMenuHighlight(), []);
  return null;
}
