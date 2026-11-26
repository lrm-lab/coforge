import {
  type DragEvent,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
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
import {
  DropdownSubmenuPopover,
  DropdownSubmenuTrigger,
  handleSubmenuItemPress,
  isVerticalMenuNavKey,
} from "./dropdown-submenu";
import { RadioButtonBase } from "#src/components/base/radio-buttons/radio-buttons";
import { ToggleBase } from "#src/components/base/toggle/toggle";
import { CascadeFolderIcon } from "#src/components/ui/cascade-folder-icon";
import {
  CascadeMenuProvider,
  CascadeSubmenuPortalProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuItem,
} from "#src/components/ui/cascade-menu-controller";
import { HotkeyKeycaps, useHotkeyAria } from "#src/components/ui/kbd";
import { cx } from "#src/utils/cx";

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

interface DropdownItemProps extends AriaMenuItemProps {
  label?: string;
  addon?: string;
  shortcut?: string;
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
  shortcut,
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
  onPress,
  ...props
}: DropdownItemProps) => {
  const keyShortcuts = useHotkeyAria(shortcut);
  const cascade = useCascadeMenu();
  const depth = useCascadeDepth();
  const submenuItem = useCascadeSubmenuItem();
  const generatedId = useId();
  const rowId = props.id !== undefined ? String(props.id) : generatedId;
  const hasSubmenu = Boolean(submenuItem);
  const submenuId = submenuItem?.submenuId ?? null;
  const triggerRef = submenuItem?.triggerRef;
  const anchorName = submenuItem?.anchorName;
  const rowState = cascade ? cascade.getRowState(depth, rowId, submenuId) : "idle";

  const submenuKeyDownRef = useRef<((event: globalThis.KeyboardEvent) => void) | null>(null);
  submenuKeyDownRef.current =
    hasSubmenu && !props.isDisabled
      ? (event: globalThis.KeyboardEvent) => {
          if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          cascade?.markSuppressRootClose();
          submenuItem?.openSubmenuNow(true);
        }
      : null;

  const setItemRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (triggerRef) {
        triggerRef.current = node;
      }
      if (node && anchorName) {
        node.style.setProperty("anchor-name", anchorName);
      }
      const onKeyDown = (event: globalThis.KeyboardEvent) => {
        submenuKeyDownRef.current?.(event);
      };
      if (node && triggerRef) {
        node.addEventListener("keydown", onKeyDown, true);
      }
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && "current" in ref) {
        ref.current = node;
      }
      if (!node) return;
      return () => {
        if (triggerRef) {
          node.removeEventListener("keydown", onKeyDown, true);
          if (anchorName) {
            node.style.removeProperty("anchor-name");
          }
          if (triggerRef.current === node) {
            triggerRef.current = null;
          }
        }
        if (typeof ref === "function") ref(null);
        else if (ref && "current" in ref) ref.current = null;
      };
    },
    [anchorName, ref, triggerRef],
  );

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (props.isDisabled) return;
      cascade?.onRowPointerEnter(
        depth,
        rowId,
        submenuId,
        event.pointerType,
        {
          x: event.clientX,
          y: event.clientY,
        },
        submenuItem?.openOnHover,
      );
    },
    [cascade, depth, props.isDisabled, rowId, submenuId, submenuItem?.openOnHover],
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

  const handleAction = useCallback(() => {
    if (submenuItem) {
      if (!props.isDisabled) {
        cascade?.markSuppressRootClose();
        submenuItem.openSubmenuNow(false);
      }
      return;
    }
    onAction?.();
  }, [cascade, onAction, props.isDisabled, submenuItem]);

  const handlePress = useCallback(
    (event: Parameters<NonNullable<AriaMenuItemProps["onPress"]>>[0]) => {
      handleSubmenuItemPress(event, {
        isDisabled: props.isDisabled,
        cascade,
        submenuItem,
        onPress,
      });
    },
    [cascade, onPress, props.isDisabled, submenuItem],
  );

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

  const submenuAriaHasPopup = hasSubmenu ? "menu" : undefined;
  const submenuAriaExpanded = hasSubmenu
    ? submenuItem?.isSubmenuOpen
      ? "true"
      : "false"
    : undefined;

  if (unstyled) {
    return (
      <AriaMenuItem
        {...props}
        ref={setItemRef}
        id={props.id ?? label}
        textValue={props.textValue ?? label}
        onAction={handleAction}
        onPress={handlePress}
        aria-haspopup={submenuAriaHasPopup}
        aria-expanded={submenuAriaExpanded}
      >
        {(state) => (
          <>
            {typeof children === "function" ? children(state) : children}
            {submenuItem?.popover}
          </>
        )}
      </AriaMenuItem>
    );
  }

  const showMorphFolder = hasSubmenu && (folderIcon || Icon === Folder);

  return (
    <AriaMenuItem
      aria-keyshortcuts={keyShortcuts}
      {...props}
      ref={setItemRef}
      onAction={handleAction}
      onPress={handlePress}
      aria-haspopup={submenuAriaHasPopup}
      aria-expanded={submenuAriaExpanded}
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
          <>
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

              <span className="min-w-0 grow truncate">
                {label || (typeof children === "function" ? children(state) : children)}
              </span>

              {addon && (
                <span className="max-w-1/2 shrink-0 truncate text-xs font-medium text-[var(--cascade-menu-quiet)]">
                  {addon}
                </span>
              )}

              {shortcut && (
                <HotkeyKeycaps
                  hotkey={shortcut}
                  hideOnTouch
                  ariaHidden
                  className="ms-2"
                />
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
            {submenuItem?.popover}
          </>
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
  const [submenuPortalEl, setSubmenuPortalEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (depth !== 0 || !cascade) return;
    if (popoverCtx && "triggerRef" in popoverCtx) {
      const el = popoverCtx.triggerRef?.current;
      if (el instanceof HTMLElement) {
        cascade.registerAnchor(el);
      }
    }
  }, [cascade, depth, popoverCtx]);

  const cascadeRef = useRef(cascade);
  cascadeRef.current = cascade;

  const setLevelRef = useCallback(
    (el: HTMLElement | null) => {
      cascadeRef.current?.registerLevel(depth, el);
    },
    [depth],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && cascade) {
        event.preventDefault();
        event.stopPropagation();
        cascade.closeAll(true);
      } else if (isVerticalMenuNavKey(event.key)) {
        cascade?.clearHoverAtDepth(depth);
      }
    },
    [cascade, depth],
  );

  return (
    <AriaPopover
      placement="bottom right"
      {...props}
      ref={setLevelRef}
      data-cascade-menu="true"
      data-cascade-level={depth === 0 ? "root" : "submenu"}
      className={(state) =>
        cx(
          "cascade-menu-level",
          typeof props.className === "function" ? props.className(state) : props.className,
        )
      }
    >
      {(renderProps) => (
        <CascadeSubmenuPortalProvider container={submenuPortalEl}>
          <div className="contents" onKeyDown={handleKeyDown}>
            {title && <div className="cascade-menu-title">{title}</div>}
            {typeof children === "function" ? children(renderProps) : children}
          </div>
          <div ref={setSubmenuPortalEl} className="contents" />
        </CascadeSubmenuPortalProvider>
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
          "cursor-pointer rounded-md text-fg-quaternary outline-focus-ring transition duration-100 ease-out",
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
