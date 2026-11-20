import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useId,
  useMemo,
  useRef,
} from "react";
import type { PopoverProps as AriaPopoverProps } from "react-aria-components";
import { MenuContext, Popover as AriaPopover, PopoverContext } from "react-aria-components";
import {
  CascadeDepthProvider,
  CascadeSubmenuItemProvider,
  CascadeSubmenuPopoverProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuPopover,
} from "#src/components/ui/cascade-menu-controller";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { CASCADE_MENU_GEOMETRY } from "#src/lib/cascade-menu-safe-zone";
import { cx } from "#src/utils/cx";

const SUBMENU_TITLE_OFFSET_PX = 22;

interface DropdownSubmenuTriggerProps {
  children: [ReactElement, ReactElement];
}

export const DropdownSubmenuTrigger = ({ children }: DropdownSubmenuTriggerProps) => {
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuId = useId();
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const focusFirstOnOpenRef = useRef(false);

  const isSubmenuOpen = cascade ? cascade.isSubmenuOpenAt(depth, submenuId) : false;

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
      triggerRef,
      defaultTitle,
      focusFirstOnOpenRef,
      onCloseSubmenu,
    }),
    [defaultTitle, onCloseSubmenu],
  );

  const itemContextValue = useMemo(
    () => ({
      submenuId,
      isSubmenuOpen,
      triggerRef,
      openSubmenuNow,
      popover: isSubmenuOpen && (
        <CascadeDepthProvider depth={depth + 1}>
          <CascadeSubmenuPopoverProvider value={popoverContextValue}>
            <MenuContext.Provider value={null}>
              <PopoverContext.Provider value={{ trigger: "SubmenuTrigger", triggerRef }}>
                {popoverElement}
              </PopoverContext.Provider>
            </MenuContext.Provider>
          </CascadeSubmenuPopoverProvider>
        </CascadeDepthProvider>
      ),
    }),
    [depth, isSubmenuOpen, openSubmenuNow, popoverContextValue, popoverElement, submenuId],
  );

  return (
    <CascadeSubmenuItemProvider value={itemContextValue}>
      {triggerElement}
    </CascadeSubmenuItemProvider>
  );
};

interface DropdownSubmenuPopoverProps
  extends Omit<AriaPopoverProps, "placement" | "offset" | "className" | "title"> {
  className?: string;
  title?: string | false;
}

export const DropdownSubmenuPopover = ({
  className,
  title,
  children,
  ...props
}: DropdownSubmenuPopoverProps) => {
  const wide = useBreakpoint("md");
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuPopover = useCascadeSubmenuPopover();
  const resolvedTitle = title === false ? undefined : (title ?? submenuPopover?.defaultTitle);

  const setLevelRef = useCallback(
    (el: HTMLElement | null) => {
      cascade?.registerLevel(depth, el);
      if (el && submenuPopover?.focusFirstOnOpenRef.current) {
        submenuPopover.focusFirstOnOpenRef.current = false;
        requestAnimationFrame(() => {
          const firstItem = el.querySelector<HTMLElement>(
            '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
          );
          firstItem?.focus();
        });
      }
    },
    [cascade, depth, submenuPopover],
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
      }
    },
    [cascade, submenuPopover],
  );

  const alignOffset =
    CASCADE_MENU_GEOMETRY.LEVEL_PADDING_PX + (resolvedTitle ? SUBMENU_TITLE_OFFSET_PX : 0);

  return (
    <AriaPopover
      {...props}
      ref={setLevelRef}
      isOpen={submenuPopover ? true : props.isOpen}
      isNonModal={submenuPopover ? true : props.isNonModal}
      triggerRef={submenuPopover?.triggerRef ?? props.triggerRef}
      shouldFlip
      placement={wide ? "end top" : "bottom start"}
      offset={wide ? -CASCADE_MENU_GEOMETRY.SUBMENU_OVERLAP_PX : 0}
      crossOffset={wide ? -alignOffset : 0}
      data-cascade-menu="true"
      data-cascade-level="submenu"
      className={cx("cascade-menu-level max-w-[calc(100vw-1.5rem)]", className)}
    >
      {(renderProps) => (
        <div className="contents" onKeyDown={handleKeyDown}>
          {resolvedTitle && <div className="cascade-menu-title">{resolvedTitle}</div>}
          {typeof children === "function" ? children(renderProps) : children}
        </div>
      )}
    </AriaPopover>
  );
};
