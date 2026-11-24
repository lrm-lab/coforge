export type PageFlowHost = {
  root: HTMLElement | null;
  win: { readonly scrollY: number; scrollTo: (x: number, y: number) => void };
};

type SavedElementStyles = {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  visibility: string;
  pointerEvents: string;
  inert: boolean;
  ariaHidden: string | null;
};

type StackEntry = {
  id: symbol;
  hiddenTarget: HTMLElement | null;
  layerEl: HTMLElement | null;
  win: PageFlowHost["win"];
  savedScrollY: number;
  savedStyles: SavedElementStyles | null;
};

const activeStack: StackEntry[] = [];

function snapshotStyles(el: HTMLElement): SavedElementStyles {
  return {
    position: el.style.position,
    top: el.style.top,
    left: el.style.left,
    right: el.style.right,
    width: el.style.width,
    visibility: el.style.visibility,
    pointerEvents: el.style.pointerEvents,
    inert: Boolean(el.inert),
    ariaHidden: el.getAttribute?.("aria-hidden") ?? null,
  };
}

function pinAndHide(el: HTMLElement, scrollY: number): SavedElementStyles {
  const saved = snapshotStyles(el);
  // Safari 26+: pin and hide the background layer with visibility: hidden while a phone
  // full-screen sheet/page scrolls in normal document flow.
  el.style.position = "fixed";
  el.style.top = `${-scrollY}px`;
  el.style.left = "0";
  el.style.right = "0";
  el.style.width = "100%";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.inert = true;
  el.setAttribute?.("aria-hidden", "true");
  return saved;
}

function restoreStyles(el: HTMLElement, saved: SavedElementStyles): void {
  el.style.position = saved.position;
  el.style.top = saved.top;
  el.style.left = saved.left;
  el.style.right = saved.right;
  el.style.width = saved.width;
  el.style.visibility = saved.visibility;
  el.style.pointerEvents = saved.pointerEvents;
  el.inert = saved.inert;
  if (typeof el.setAttribute === "function" && typeof el.removeAttribute === "function") {
    if (saved.ariaHidden === null) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", saved.ariaHidden);
  }
}

export function acquirePageFlowHandoff({
  root,
  win,
  layerEl = null,
  initialScrollTop = 0,
}: PageFlowHost & { layerEl?: HTMLElement | null; initialScrollTop?: number }): {
  id: symbol;
  release: (onHandBackScroll?: (pageScrollY: number) => void) => void;
} {
  const id = Symbol("page-flow");
  const savedScrollY = win.scrollY;
  const previous = activeStack.at(-1);
  const hiddenTarget = previous ? previous.layerEl : root;
  const savedStyles = hiddenTarget ? pinAndHide(hiddenTarget, savedScrollY) : null;

  activeStack.push({ id, hiddenTarget, layerEl, win, savedScrollY, savedStyles });
  win.scrollTo(0, Math.max(0, initialScrollTop));

  let released = false;
  const release = (onHandBackScroll?: (pageScrollY: number) => void) => {
    if (released) return;
    released = true;

    const index = activeStack.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const [entry] = activeStack.splice(index, 1);
    if (!entry) return;

    const wasTop = index === activeStack.length;
    const pageScrollY = entry.win.scrollY;
    onHandBackScroll?.(pageScrollY);

    if (wasTop) {
      if (entry.hiddenTarget && entry.savedStyles) {
        restoreStyles(entry.hiddenTarget, entry.savedStyles);
      }
      entry.win.scrollTo(0, entry.savedScrollY);
    } else if (index === 0) {
      const nextBottom = activeStack[0]!;
      nextBottom.hiddenTarget = entry.hiddenTarget;
      nextBottom.savedStyles = entry.savedStyles;
      nextBottom.savedScrollY = entry.savedScrollY;
    } else {
      const above = activeStack[index]!;
      above.hiddenTarget = entry.hiddenTarget;
      above.savedStyles = entry.savedStyles;
      above.savedScrollY = entry.savedScrollY;
    }
  };

  return { id, release };
}

export function isTopPageFlowEntry(id: symbol): boolean {
  return activeStack.at(-1)?.id === id;
}

export function activePageFlowDepth(): number {
  return activeStack.length;
}
