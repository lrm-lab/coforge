import { createContext, type ReactNode, type RefObject, useContext } from "react";
import type { Point, RectLike } from "#src/lib/cascade-menu-safe-zone";

export type CascadeRowState = "idle" | "hovered" | "active" | "skipped";

export interface CascadeMenuContextValue {
  readonly isRootOpen: boolean;
  readonly openPath: readonly string[];
  readonly isSubmenuOpenAt: (depth: number, submenuId: string) => boolean;
  readonly getRowState: (depth: number, rowId: string, submenuId: string | null) => CascadeRowState;
  readonly getLevelRect: (depth: number) => RectLike | null;
  readonly registerAnchor: (el: HTMLElement | null) => void;
  readonly registerLevel: (depth: number, el: HTMLElement | null) => void;
  readonly onRowPointerEnter: (
    depth: number,
    rowId: string,
    submenuId: string | null,
    pointerType: string,
    point: Point,
    openOnHover?: boolean,
  ) => void;
  readonly onRowPointerLeave: (depth: number, rowId: string) => void;
  readonly clearHoverAtDepth: (depth: number) => void;
  readonly onFolderDragEnter: (depth: number, rowId: string, submenuId: string) => void;
  readonly onFolderDragLeave: (depth: number, rowId: string) => void;
  readonly openSubmenuNow: (depth: number, submenuId: string) => void;
  readonly closeFromDepth: (depth: number) => void;
  readonly closeAll: (restoreFocus?: boolean) => void;
  readonly markSuppressRootClose: () => void;
  readonly consumeSuppressRootClose: () => boolean;
}

export interface CascadeSubmenuItemContextValue {
  readonly submenuId: string;
  readonly anchorName: string;
  readonly isSubmenuOpen: boolean;
  readonly openOnHover: boolean;
  readonly triggerRef: RefObject<HTMLDivElement | null>;
  readonly openSubmenuNow: (focusFirstItem: boolean) => void;
  readonly popover: ReactNode;
}

export interface CascadeSubmenuPopoverContextValue {
  readonly anchorName: string;
  readonly isOpen: boolean;
  readonly triggerRef: RefObject<HTMLDivElement | null>;
  readonly defaultTitle?: string;
  readonly focusFirstOnOpenRef: RefObject<boolean>;
  readonly onCloseSubmenu: () => void;
  readonly onExited: () => void;
}

export const CascadeMenuContext = createContext<CascadeMenuContextValue | null>(null);
export const CascadeDepthContext = createContext<number>(0);
const CascadeSubmenuItemContext = createContext<CascadeSubmenuItemContextValue | null>(null);
const CascadeSubmenuPopoverContext = createContext<CascadeSubmenuPopoverContextValue | null>(null);
const CascadeSubmenuPortalContext = createContext<HTMLElement | null>(null);

export function useCascadeMenu(): CascadeMenuContextValue | null {
  return useContext(CascadeMenuContext);
}

export function useCascadeDepth(): number {
  return useContext(CascadeDepthContext);
}

export function useCascadeSubmenuItem(): CascadeSubmenuItemContextValue | null {
  return useContext(CascadeSubmenuItemContext);
}

export function useCascadeSubmenuPopover(): CascadeSubmenuPopoverContextValue | null {
  return useContext(CascadeSubmenuPopoverContext);
}

export function useCascadeSubmenuPortal(): HTMLElement | null {
  return useContext(CascadeSubmenuPortalContext);
}

export function CascadeDepthProvider({ depth, children }: { depth: number; children: ReactNode }) {
  return <CascadeDepthContext.Provider value={depth}>{children}</CascadeDepthContext.Provider>;
}

export function CascadeSubmenuItemProvider({
  value,
  children,
}: {
  value: CascadeSubmenuItemContextValue;
  children: ReactNode;
}) {
  return (
    <CascadeSubmenuItemContext.Provider value={value}>
      {children}
    </CascadeSubmenuItemContext.Provider>
  );
}

export function CascadeSubmenuPopoverProvider({
  value,
  children,
}: {
  value: CascadeSubmenuPopoverContextValue;
  children: ReactNode;
}) {
  return (
    <CascadeSubmenuPopoverContext.Provider value={value}>
      {children}
    </CascadeSubmenuPopoverContext.Provider>
  );
}

export function CascadeSubmenuPortalProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <CascadeSubmenuPortalContext.Provider value={container}>
      {children}
    </CascadeSubmenuPortalContext.Provider>
  );
}

export function toRectLike(el: HTMLElement): RectLike {
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function measureCascadeLevels(
  anchorEl: HTMLElement | null,
  levelEls: ReadonlyMap<number, HTMLElement>,
  point: Point,
  containsPoint: (pt: Point, rect: RectLike) => boolean,
): {
  measuredLevels: Map<number, RectLike>;
  rects: RectLike[];
  insideSubmenuDepth: number;
} {
  const measuredLevels = new Map<number, RectLike>();
  const rects: RectLike[] = [];
  if (anchorEl) {
    rects.push(toRectLike(anchorEl));
  }
  let insideSubmenuDepth = -1;
  for (const [depth, el] of levelEls.entries()) {
    const rect = toRectLike(el);
    measuredLevels.set(depth, rect);
    rects.push(rect);
    if (depth >= 1 && containsPoint(point, rect)) {
      insideSubmenuDepth = Math.max(insideSubmenuDepth, depth);
    }
  }
  return { measuredLevels, rects, insideSubmenuDepth };
}
