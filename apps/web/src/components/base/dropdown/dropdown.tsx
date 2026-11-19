import {
  type DragEvent,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronRight, DotsVertical, Folder } from "@untitledui/icons";
import type {
  ButtonProps as AriaButtonProps,
  MenuItemProps as AriaMenuItemProps,
  MenuItemRenderProps,
  MenuProps as AriaMenuProps,
  MenuTriggerProps as AriaMenuTriggerProps,
  PopoverProps as AriaPopoverProps,
  SeparatorProps as AriaSeparatorProps,
} from "react-aria-components";
import {
  Button as AriaButton,
  Header as AriaHeader,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger as AriaMenuTrigger,
  Popover as AriaPopover,
  PopoverContext,
  Separator as AriaSeparator,
} from "react-aria-components";
import { Avatar } from "#src/components/base/avatar/avatar";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { RadioButtonBase } from "#src/components/base/radio-buttons/radio-buttons";
import { ToggleBase } from "#src/components/base/toggle/toggle";
import { CascadeFolderIcon } from "#src/components/ui/cascade-folder-icon";
import {
  CascadeDepthProvider,
  CascadeMenuProvider,
  CascadeSubmenuItemProvider,
  CascadeSubmenuPopoverProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuItem,
  useCascadeSubmenuPopover,
} from "#src/components/ui/cascade-menu-controller";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { CASCADE_MENU_GEOMETRY } from "#src/lib/cascade-menu-safe-zone";
import { cx } from "#src/utils/cx";

const SUBMENU_TITLE_OFFSET_PX = 22;

interface DropdownRootProps extends AriaMenuTriggerProps {
  debugSafeZone?: boolean;
}

const DropdownRootInner = ({
  isOpen,
  onOpenChange,
  children,
  ...props
}: Omit<AriaMenuTriggerProps, "isOpen" | "onOpenChange"> & {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const cascade = useCascadeMenu();
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && cascade?.consumeSuppressRootClose()) {
        return;
      }
      onOpenChange(next);
    },
    [cascade, onOpenChange],
  );
  return (
    <AriaMenuTrigger {...props} isOpen={isOpen} onOpenChange={handleOpenChange}>
      {children}
    </AriaMenuTrigger>
  );
};

const DropdownRoot = ({
  isOpen: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  debugSafeZone = false,
  children,
  ...props
}: DropdownRootProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const handleRequestClose = useCallback(() => setOpen(false), [setOpen]);

  return (
    <CascadeMenuProvider
      isRootOpen={isOpen}
      onRequestRootClose={handleRequestClose}
      debugSafeZone={debugSafeZone}
    >
      <DropdownRootInner {...props} isOpen={isOpen} onOpenChange={setOpen}>
        {children}
      </DropdownRootInner>
    </CascadeMenuProvider>
  );
};

interface DropdownSubmenuTriggerProps {
  children: [ReactElement, ReactElement];
}

const DropdownSubmenuTrigger = ({ children }: DropdownSubmenuTriggerProps) => {
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

  const itemContextValue = useMemo(
    () => ({
      submenuId,
      isSubmenuOpen,
      triggerRef,
      openSubmenuNow,
    }),
    [isSubmenuOpen, openSubmenuNow, submenuId],
  );

  const popoverContextValue = useMemo(
    () => ({
      triggerRef,
      defaultTitle,
      focusFirstOnOpenRef,
      onCloseSubmenu,
    }),
    [defaultTitle, onCloseSubmenu],
  );

  return (
    <CascadeSubmenuItemProvider value={itemContextValue}>
      {triggerElement}
      {isSubmenuOpen && (
        <CascadeDepthProvider depth={depth + 1}>
          <CascadeSubmenuPopoverProvider value={popoverContextValue}>
            {popoverElement}
          </CascadeSubmenuPopoverProvider>
        </CascadeDepthProvider>
      )}
    </CascadeSubmenuItemProvider>
  );
};

interface DropdownItemProps extends AriaMenuItemProps {
  label?: string;
  addon?: string;
  count?: number;
  unstyled?: boolean;
  icon?: FC<{ className?: string }>;
  folderIcon?: boolean;
  monochromeIcon?: boolean;
  avatarUrl?: string;
  leading?: ReactNode;
  selectionIndicator?: "checkmark" | "checkbox" | "radio" | "toggle" | "none";
  ref?: Ref<HTMLDivElement>;
}

const DropdownItem = ({
  label,
  children,
  addon,
  count,
  icon: Icon,
  folderIcon,
  monochromeIcon,
  avatarUrl,
  leading,
  unstyled,
  selectionIndicator = "checkmark",
  ref,
  onAction,
  ...props
}: DropdownItemProps) => {
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuItem = useCascadeSubmenuItem();
  const generatedId = useId();
  const rowId = props.id !== undefined ? String(props.id) : generatedId;
  const hasSubmenu = Boolean(submenuItem);
  const submenuId = submenuItem?.submenuId ?? null;
  const rowState = cascade ? cascade.getRowState(depth, rowId, submenuId) : "idle";

  const setItemRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (submenuItem) {
        submenuItem.triggerRef.current = node;
      }
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && "current" in ref) {
        ref.current = node;
      }
    },
    [ref, submenuItem],
  );

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (props.isDisabled) return;
      cascade?.onRowPointerEnter(depth, rowId, submenuId, event.pointerType, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [cascade, depth, props.isDisabled, rowId, submenuId],
  );

  const handlePointerLeave = useCallback(() => {
    cascade?.onRowPointerLeave(depth, rowId);
  }, [cascade, depth, rowId]);

  const handleDragEnter = useCallback(() => {
    if (props.isDisabled || !submenuId) return;
    cascade?.onFolderDragEnter(depth, rowId, submenuId);
  }, [cascade, depth, props.isDisabled, rowId, submenuId]);

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!submenuId) return;
      const related = event.relatedTarget as Node | null;
      if (related && event.currentTarget.contains(related)) return;
      cascade?.onFolderDragLeave(depth, rowId);
    },
    [cascade, depth, rowId, submenuId],
  );

  const handleDrop = useCallback(() => {
    if (!submenuId) return;
    cascade?.onFolderDragLeave(depth, rowId);
  }, [cascade, depth, rowId, submenuId]);

  useEffect(() => {
    if (props.isDisabled || !submenuItem) return;
    const el = submenuItem.triggerRef.current;
    if (!el) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        cascade?.markSuppressRootClose();
        submenuItem.openSubmenuNow(true);
      }
    };
    el.addEventListener("keydown", onKeyDown, true);
    return () => el.removeEventListener("keydown", onKeyDown, true);
  }, [cascade, props.isDisabled, submenuItem]);

  const handleAction = useCallback(() => {
    if (submenuItem) {
      cascade?.markSuppressRootClose();
      submenuItem.openSubmenuNow(false);
      return;
    }
    onAction?.();
  }, [cascade, onAction, submenuItem]);

  const SelectionIndicator = useCallback(
    (state: MenuItemRenderProps & { className?: string }) => {
      if (selectionIndicator === "checkmark") {
        return (
          <Check
            aria-hidden="true"
            className={cx(
              "size-4 shrink-0 stroke-[2.25px] text-fg-brand-primary",
              !state.isSelected && "invisible",
              state.className,
            )}
          />
        );
      }
      if (selectionIndicator === "checkbox") {
        return (
          <CheckboxBase
            isSelected={state.isSelected && !state.hasSubmenu}
            isIndeterminate={state.isSelected && state.hasSubmenu}
            size="sm"
            className={cx("shrink-0", state.className)}
          />
        );
      }
      if (selectionIndicator === "radio") {
        return <RadioButtonBase isSelected={state.isSelected} className={cx("shrink-0", state.className)} />;
      }
      if (selectionIndicator === "toggle") {
        return <ToggleBase slim size="sm" isSelected={state.isSelected} className={cx("shrink-0", state.className)} />;
      }
      return null;
    },
    [selectionIndicator],
  );

  if (unstyled) {
    return <AriaMenuItem ref={setItemRef} id={label} textValue={label} onAction={handleAction} {...props} />;
  }

  const showMorphFolder = hasSubmenu && (folderIcon || Icon === Folder);

  return (
    <AriaMenuItem
      {...props}
      ref={setItemRef}
      onAction={handleAction}
      aria-haspopup={hasSubmenu ? "menu" : undefined}
      aria-expanded={hasSubmenu ? submenuItem?.isSubmenuOpen : undefined}
      data-cascade-state={rowState}
      className={(state) =>
        cx(
          "block cursor-pointer outline-hidden",
          state.isDisabled && "cursor-not-allowed opacity-50",
          typeof props.className === "function" ? props.className(state) : props.className,
        )
      }
    >
      {(state) => {
        const effectiveState =
          rowState === "skipped"
            ? "skipped"
            : rowState === "active"
              ? "active"
              : rowState === "hovered"
                ? "hovered"
                : state.isFocusVisible
                  ? "hovered"
                  : "idle";

        return (
          <div
            data-cascade-state={effectiveState}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cx(
              "cascade-menu-row outline-focus-ring",
              state.isFocusVisible && "outline-2 -outline-offset-2",
            )}
          >
            {state.selectionMode !== "none" && !avatarUrl && !Icon && !leading && !showMorphFolder && (
              <SelectionIndicator {...state} />
            )}

            {avatarUrl && (
              <div className="flex size-[18px] shrink-0 items-center justify-center">
                <Avatar aria-hidden="true" size="xs" src={avatarUrl} alt={label} className="size-[18px]" />
              </div>
            )}

            {showMorphFolder ? (
              <CascadeFolderIcon open={Boolean(submenuItem?.isSubmenuOpen)} className="cascade-menu-icon" />
            ) : Icon ? (
              <span className="cascade-menu-icon" data-monochrome-icon={monochromeIcon ? "true" : undefined}>
                <Icon aria-hidden="true" className="size-[18px] shrink-0 stroke-[1.9px]" />
              </span>
            ) : null}

            {leading && (
              <span
                className="cascade-menu-icon"
                data-monochrome-icon={monochromeIcon ? "true" : undefined}
              >
                {leading}
              </span>
            )}

            <span className="grow truncate">
              {label || (typeof children === "function" ? children(state) : children)}
            </span>

            {addon && (
              <span className="max-w-1/2 shrink-0 truncate text-xs font-medium text-[var(--cascade-menu-quiet)]">
                {addon}
              </span>
            )}

            {count !== undefined && (
              <span className="shrink-0 text-xs font-medium text-[var(--cascade-menu-quiet)] tabular-nums">
                {count}
              </span>
            )}

            {state.selectionMode !== "none" && (avatarUrl || Icon || leading || showMorphFolder) && (
              <SelectionIndicator {...state} />
            )}

            {(hasSubmenu || state.hasSubmenu) && (
              <ChevronRight aria-hidden="true" className="cascade-menu-chevron stroke-[2.25px]" />
            )}
          </div>
        );
      }}
    </AriaMenuItem>
  );
};

interface DropdownMenuProps<T extends object> extends AriaMenuProps<T> {}

const DropdownMenu = <T extends object>(props: DropdownMenuProps<T>) => {
  return (
    <AriaMenu
      escapeKeyBehavior="none"
      {...props}
      className={(state) =>
        cx(
          "cascade-menu-list",
          typeof props.className === "function" ? props.className(state) : props.className,
        )
      }
    />
  );
};

interface DropdownPopoverProps extends AriaPopoverProps {
  title?: string;
}

const DropdownPopover = ({ title, children, ...props }: DropdownPopoverProps) => {
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const popoverCtx = useContext(PopoverContext);

  useEffect(() => {
    if (depth !== 0 || !cascade) return;
    if (popoverCtx && "triggerRef" in popoverCtx) {
      const el = popoverCtx.triggerRef?.current;
      if (el instanceof HTMLElement) {
        cascade.registerAnchor(el);
      }
    }
  }, [cascade, depth, popoverCtx]);

  const setLevelRef = useCallback(
    (el: HTMLElement | null) => {
      cascade?.registerLevel(depth, el);
    },
    [cascade, depth],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cascade?.closeAll(true);
      }
    },
    [cascade],
  );

  return (
    <AriaPopover
      placement="bottom right"
      {...props}
      ref={setLevelRef}
      data-cascade-menu="true"
      data-cascade-level={depth === 0 ? "root" : "submenu"}
      onKeyDown={handleKeyDown}
      className={(state) =>
        cx(
          "cascade-menu-level",
          typeof props.className === "function" ? props.className(state) : props.className,
        )
      }
    >
      {(renderProps) => (
        <>
          {title && <div className="cascade-menu-title">{title}</div>}
          {typeof children === "function" ? children(renderProps) : children}
        </>
      )}
    </AriaPopover>
  );
};

interface DropdownSubmenuPopoverProps
  extends Omit<DropdownPopoverProps, "placement" | "offset" | "className" | "title"> {
  className?: string;
  title?: string | false;
}

const DropdownSubmenuPopover = ({ className, title, children, ...props }: DropdownSubmenuPopoverProps) => {
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
          const firstItem = el.querySelector<HTMLElement>('[role="menuitem"]');
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
      onKeyDown={handleKeyDown}
      className={cx("cascade-menu-level max-w-[calc(100vw-1.5rem)]", className)}
    >
      {(renderProps) => (
        <>
          {resolvedTitle && <div className="cascade-menu-title">{resolvedTitle}</div>}
          {typeof children === "function" ? children(renderProps) : children}
        </>
      )}
    </AriaPopover>
  );
};

const DropdownSeparator = (props: AriaSeparatorProps) => {
  return <AriaSeparator {...props} className={cx("my-1 h-px w-full bg-[var(--cascade-menu-border)]", props.className)} />;
};

const DropdownDotsButton = (props: AriaButtonProps & RefAttributes<HTMLButtonElement>) => {
  return (
    <AriaButton
      {...props}
      aria-label="Open menu"
      className={(state) =>
        cx(
          "cursor-pointer rounded-md text-fg-quaternary outline-focus-ring transition duration-100 ease-linear",
          (state.isPressed || state.isHovered) && "text-fg-quaternary_hover",
          (state.isPressed || state.isFocusVisible) && "outline-2 outline-offset-2",
          typeof props.className === "function" ? props.className(state) : props.className,
        )
      }
    >
      <DotsVertical className="size-5 transition-inherit-all" />
    </AriaButton>
  );
};

export const Dropdown = {
  Root: DropdownRoot,
  Popover: DropdownPopover,
  SubmenuTrigger: DropdownSubmenuTrigger,
  SubmenuPopover: DropdownSubmenuPopover,
  Menu: DropdownMenu,
  Section: AriaMenuSection,
  SectionHeader: AriaHeader,
  Item: DropdownItem,
  Separator: DropdownSeparator,
  DotsButton: DropdownDotsButton,
  FolderIcon: CascadeFolderIcon,
};
