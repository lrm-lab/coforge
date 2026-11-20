import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TransitionEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MenuContext } from "react-aria-components";
import {
  CascadeDepthProvider,
  CascadeSubmenuItemProvider,
  CascadeSubmenuPopoverProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuPopover,
  useCascadeSubmenuPortal,
} from "#src/components/ui/cascade-menu-controller";
import {
  CASCADE_MENU_GEOMETRY,
  CASCADE_MENU_TIMINGS,
  resolveSubmenuSide,
  type SubmenuSide,
} from "#src/lib/cascade-menu-safe-zone";
import { cx } from "#src/utils/cx";

const SUBMENU_TITLE_OFFSET_PX = 22;

export function isVerticalMenuNavKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

interface DropdownSubmenuTriggerProps {
  children: [ReactElement, ReactElement];
}

export const DropdownSubmenuTrigger = ({ children }: DropdownSubmenuTriggerProps) => {
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuId = useId();
  const anchorName = useMemo(
    () => `--cascade-${depth}-${submenuId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [depth, submenuId],
  );
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const focusFirstOnOpenRef = useRef(false);

  const isSubmenuOpen = cascade ? cascade.isSubmenuOpenAt(depth, submenuId) : false;
  const [mounted, setMounted] = useState(isSubmenuOpen);
  if (isSubmenuOpen && !mounted) {
    setMounted(true);
  }

  const onExited = useCallback(() => {
    setMounted(false);
  }, []);

  const openSubmenuNow = useCallback(
    (focusFirstItem: boolean) => {
      focusFirstOnOpenRef.current = focusFirstItem;
      cascade?.openSubmenuNow(depth, submenuId);
    },
    [cascade, depth, submenuId],
  );

  const onCloseSubmenu = useCallback(() => {
    cascade?.closeFromDepth(depth);
    triggerRef.current?.focus();
  }, [cascade, depth]);

  const [triggerElement, popoverElement] = children;
  const triggerProps = triggerElement.props as { label?: string; textValue?: string };
  const defaultTitle = triggerProps.label ?? triggerProps.textValue;

  const popoverContextValue = useMemo(
    () => ({
      anchorName,
      isOpen: isSubmenuOpen,
      triggerRef,
      defaultTitle,
      focusFirstOnOpenRef,
      onCloseSubmenu,
      onExited,
    }),
    [anchorName, defaultTitle, isSubmenuOpen, onCloseSubmenu, onExited],
  );

  const itemContextValue = useMemo(
    () => ({
      submenuId,
      isSubmenuOpen,
      triggerRef,
      openSubmenuNow,
      popover: mounted && (
        <CascadeDepthProvider depth={depth + 1}>
          <CascadeSubmenuPopoverProvider value={popoverContextValue}>
            <MenuContext.Provider value={null}>{popoverElement}</MenuContext.Provider>
          </CascadeSubmenuPopoverProvider>
        </CascadeDepthProvider>
      ),
    }),
    [depth, isSubmenuOpen, mounted, openSubmenuNow, popoverContextValue, popoverElement, submenuId],
  );

  return (
    <CascadeSubmenuItemProvider value={itemContextValue}>
      {triggerElement}
    </CascadeSubmenuItemProvider>
  );
};

interface DropdownSubmenuPopoverProps {
  className?: string;
  title?: string | false;
  children?: ReactNode;
}

export const DropdownSubmenuPopover = ({
  className,
  title,
  children,
}: DropdownSubmenuPopoverProps) => {
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuPopover = useCascadeSubmenuPopover();
  const submenuPortal = useCascadeSubmenuPortal();
  const popoverElRef = useRef<HTMLDivElement | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [side, setSide] = useState<SubmenuSide>("right");

  const resolvedTitle = title === false ? undefined : (title ?? submenuPopover?.defaultTitle);
  const isOpen = submenuPopover?.isOpen ?? false;
  const alignOffset =
    CASCADE_MENU_GEOMETRY.LEVEL_PADDING_PX + (resolvedTitle ? SUBMENU_TITLE_OFFSET_PX : 0);

  const onExited = submenuPopover?.onExited;
  const finishExit = useCallback(() => {
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    onExited?.();
  }, [onExited]);

  const cascadeRef = useRef(cascade);
  cascadeRef.current = cascade;
  const triggerRef = submenuPopover?.triggerRef;
  const anchorName = submenuPopover?.anchorName;
  const focusFirstOnOpenRef = submenuPopover?.focusFirstOnOpenRef;

  useLayoutEffect(() => {
    const el = popoverElRef.current;
    if (!el || !anchorName || !triggerRef) return;

    triggerRef.current?.style.setProperty("anchor-name", anchorName);
    el.style.setProperty("position-anchor", anchorName);
    el.style.setProperty("--cascade-submenu-top-offset", `${alignOffset}px`);

    if (isOpen) {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (!el.matches(":popover-open")) {
        el.showPopover();
      }
      cascadeRef.current?.registerLevel(depth, el);

      const parentRect = cascadeRef.current?.getLevelRect(depth - 1);
      const submenuRect = el.getBoundingClientRect();
      if (parentRect && submenuRect.width > 0) {
        setSide(resolveSubmenuSide(parentRect, submenuRect));
      }

      if (focusFirstOnOpenRef?.current) {
        focusFirstOnOpenRef.current = false;
        requestAnimationFrame(() => {
          const firstItem = el.querySelector<HTMLElement>(
            '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
          );
          firstItem?.focus();
        });
      }
      return;
    }

    cascadeRef.current?.registerLevel(depth, null);
    if (el.matches(":popover-open")) {
      el.hidePopover();
    }
    exitTimerRef.current = setTimeout(finishExit, CASCADE_MENU_TIMINGS.LEVEL_TRANSFORM_MS + 40);
  }, [alignOffset, anchorName, depth, finishExit, focusFirstOnOpenRef, isOpen, triggerRef]);

  useEffect(() => {
    const el = popoverElRef.current;
    return () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      cascadeRef.current?.registerLevel(depth, null);
      triggerRef?.current?.style.removeProperty("anchor-name");
      if (el?.isConnected && el.matches(":popover-open")) {
        el.hidePopover();
      }
    };
  }, [depth, triggerRef]);

  const handleTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLDivElement>) => {
      if (isOpen || event.target !== event.currentTarget) return;
      if (event.propertyName === "display" || event.propertyName === "overlay") {
        finishExit();
      }
    },
    [finishExit, isOpen],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        submenuPopover?.onCloseSubmenu();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cascade?.closeAll(true);
      } else if (isVerticalMenuNavKey(event.key)) {
        cascade?.clearHoverAtDepth(depth);
      }
    },
    [cascade, depth, submenuPopover],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverElRef}
      popover="manual"
      data-cascade-menu="true"
      data-cascade-level="submenu"
      data-trigger="SubmenuTrigger"
      data-placement={side}
      onKeyDown={handleKeyDown}
      onTransitionEnd={handleTransitionEnd}
      className={cx("cascade-menu-level max-w-[calc(100vw-1.5rem)]", className)}
    >
      {resolvedTitle && <div className="cascade-menu-title">{resolvedTitle}</div>}
      {children}
    </div>,
    submenuPortal ?? document.body,
  );
};
