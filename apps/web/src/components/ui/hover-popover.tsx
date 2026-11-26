import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Button,
  Focusable,
  OverlayTriggerStateContext,
  Popover,
  PreviewTrigger,
  type ButtonProps,
} from "react-aria-components";
import { chipControl } from "#src/lib/chip-control";
import {
  createHoverCardGroupStore,
  type HoverCardGroupOverlaySnapshot,
  type HoverCardGroupStore,
} from "#src/lib/hover-card-group-store";
import { CARD_CLOSE_DELAY_MS, CARD_OPEN_DELAY_MS, CARD_SWAP_SLOW_MS } from "#src/lib/hover-intent";
import { cn } from "#src/lib/utils";

const TOUCH_LONG_PRESS_MS = 500;

const CARD_BRIDGE_CLASS =
  "relative overflow-visible before:pointer-events-auto before:absolute before:content-[''] data-[placement=bottom]:before:inset-x-0 data-[placement=bottom]:before:-top-3.5 data-[placement=bottom]:before:h-3.5 data-[placement=top]:before:inset-x-0 data-[placement=top]:before:-bottom-3.5 data-[placement=top]:before:h-3.5 data-[placement=right]:before:inset-y-0 data-[placement=right]:before:-left-3.5 data-[placement=right]:before:w-3.5 data-[placement=left]:before:inset-y-0 data-[placement=left]:before:-right-3.5 data-[placement=left]:before:w-3.5";

const CARD_SURFACE_CLASS =
  "z-50 w-80 max-w-[calc(100vw-1.5rem)] origin-(--trigger-anchor-point) rounded-2xl border border-secondary bg-primary text-primary shadow-lg outline-none";

const CARD_MOTION_CLASS =
  "data-[entering]:animate-in data-[entering]:fade-in data-[entering]:motion-card-enter motion-safe:data-[entering]:data-[placement=bottom]:slide-in-from-top-1 motion-safe:data-[entering]:data-[placement=top]:slide-in-from-bottom-1 motion-safe:data-[entering]:data-[placement=left]:slide-in-from-right-1 motion-safe:data-[entering]:data-[placement=right]:slide-in-from-left-1 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:motion-card-leave";

interface RegisteredCardEntry {
  readonly id: string;
  readonly className?: string;
  readonly triggerEl: HTMLElement | null;
  readonly onOpen?: () => void;
  readonly renderContent: () => ReactNode;
}

const SERVER_OVERLAY_SNAPSHOT: HoverCardGroupOverlaySnapshot<RegisteredCardEntry> = {
  snapshot: { activeId: null, swapped: false },
  activeEntry: null,
  revision: 0,
};

interface HoverCardGroupContextValue {
  readonly isActive: (id: string) => boolean;
  readonly subscribeActive: (id: string, listener: () => void) => () => void;
  readonly register: (entry: RegisteredCardEntry) => void;
  readonly unregister: (id: string) => void;
  readonly pointerEnterTrigger: (id: string, x: number, y: number) => void;
  readonly pointerLeaveTrigger: (id: string) => void;
  readonly focusTrigger: (id: string) => void;
  readonly blurTrigger: (id: string) => void;
  readonly openImmediate: (id: string) => void;
  readonly closeImmediate: (restoreFocus?: boolean) => void;
}

const HoverCardGroupContext = createContext<HoverCardGroupContextValue | null>(null);

export function HoverCardGroup({
  children,
  openDelayMs = CARD_OPEN_DELAY_MS,
  closeDelayMs = CARD_CLOSE_DELAY_MS,
  swapSlowMs = CARD_SWAP_SLOW_MS,
}: {
  children: ReactNode;
  openDelayMs?: number;
  closeDelayMs?: number;
  swapSlowMs?: number;
}) {
  const activeTriggerRef = useRef<Element | null>(null);
  const storeRef = useRef<HoverCardGroupStore<RegisteredCardEntry> | null>(null);

  if (storeRef.current === null) {
    storeRef.current = createHoverCardGroupStore<RegisteredCardEntry>({
      openDelayMs,
      closeDelayMs,
      swapSlowMs,
    });
  }
  const store = storeRef.current;

  useEffect(() => {
    store.activate({ openDelayMs, closeDelayMs, swapSlowMs });
    return () => {
      store.dispose();
    };
  }, [closeDelayMs, openDelayMs, store, swapSlowMs]);

  const closeImmediate = useCallback(
    (restoreFocus = false) => {
      const triggerEl =
        store.getOverlaySnapshot().activeEntry?.triggerEl ?? activeTriggerRef.current;
      store.closeImmediate();
      if (restoreFocus && triggerEl instanceof HTMLElement) {
        triggerEl.focus();
      }
    },
    [store],
  );

  const contextValue = useMemo<HoverCardGroupContextValue>(
    () => ({
      isActive: (id) => store.isActive(id),
      subscribeActive: (id, listener) => store.subscribeActive(id, listener),
      register: (entry) => store.register(entry),
      unregister: (id) => store.unregister(id),
      pointerEnterTrigger: (id, x, y) => store.pointerEnterTrigger(id, x, y),
      pointerLeaveTrigger: (id) => store.pointerLeaveTrigger(id),
      focusTrigger: (id) => store.focusTrigger(id),
      blurTrigger: (id) => store.blurTrigger(id),
      openImmediate: (id) => store.openImmediate(id),
      closeImmediate,
    }),
    [closeImmediate, store],
  );

  return (
    <HoverCardGroupContext.Provider value={contextValue}>
      {children}
      <HoverCardGroupOverlay
        store={store}
        activeTriggerRef={activeTriggerRef}
        closeImmediate={closeImmediate}
      />
    </HoverCardGroupContext.Provider>
  );
}

function HoverCardGroupOverlay({
  store,
  activeTriggerRef,
  closeImmediate,
}: {
  store: HoverCardGroupStore<RegisteredCardEntry>;
  activeTriggerRef: RefObject<Element | null>;
  closeImmediate: (restoreFocus?: boolean) => void;
}) {
  const lastOpenedIdRef = useRef<string | null>(null);
  const subscribeOverlay = useCallback(
    (listener: () => void) => store.subscribeOverlay(listener),
    [store],
  );
  const getOverlaySnapshot = useCallback(() => store.getOverlaySnapshot(), [store]);
  const { snapshot, activeEntry } = useSyncExternalStore(
    subscribeOverlay,
    getOverlaySnapshot,
    () => SERVER_OVERLAY_SNAPSHOT,
  );

  useEffect(() => {
    if (snapshot.activeId === null) {
      lastOpenedIdRef.current = null;
      return;
    }
    if (lastOpenedIdRef.current !== snapshot.activeId) {
      lastOpenedIdRef.current = snapshot.activeId;
      store.getOverlaySnapshot().activeEntry?.onOpen?.();
    }
  }, [snapshot.activeId, store]);

  useEffect(() => {
    if (snapshot.activeId === null) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") return;
      store.pointerMove(event.clientX, event.clientY);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      closeImmediate(true);
    };
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeImmediate, snapshot.activeId, store]);

  if (activeEntry?.triggerEl) {
    activeTriggerRef.current = activeEntry.triggerEl;
  }

  const overlayState = useMemo(
    () => ({
      isOpen: activeEntry !== null,
      setOpen(next: boolean) {
        if (!next) closeImmediate(false);
      },
      open() {},
      close() {
        closeImmediate(false);
      },
      toggle() {
        closeImmediate(false);
      },
      point: null,
      setPoint() {},
    }),
    [activeEntry, closeImmediate],
  );

  return (
    <Popover
      isNonModal
      trigger="PreviewTrigger"
      isOpen={activeEntry !== null && activeTriggerRef.current !== null}
      triggerRef={activeTriggerRef}
      onOpenChange={(open) => {
        if (!open) closeImmediate(false);
      }}
      placement="bottom start"
      offset={12}
      containerPadding={12}
      shouldSkipAnimation={false}
      onPointerEnter={() => store.pointerEnterCard()}
      onPointerLeave={() => store.pointerLeaveCard()}
      className={cn(
        CARD_SURFACE_CLASS,
        CARD_BRIDGE_CLASS,
        CARD_MOTION_CLASS,
        snapshot.swapped && "motion-safe:transition-[left,top] motion-safe:duration-200",
        activeEntry?.className,
      )}
    >
      <OverlayTriggerStateContext.Provider value={overlayState}>
        {activeEntry && (
          <div
            key={activeEntry.id}
            className={cn(
              "min-w-0 max-h-[min(28rem,calc(100dvh-2rem))] overflow-x-hidden overflow-y-auto rounded-[inherit]",
              snapshot.swapped && "animate-[coforge-card-swap-in_200ms_var(--ease-out)]",
            )}
          >
            {activeEntry.renderContent()}
          </div>
        )}
      </OverlayTriggerStateContext.Provider>
    </Popover>
  );
}

export function HoverPopover({
  label,
  trigger,
  triggerClassName,
  className,
  children,
  onOpen,
  onPress,
  working,
  inline,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  className?: string;
  children: ReactNode;
  onOpen?: () => void;
  onPress?: () => void;
  working?: boolean;
  inline?: boolean;
}) {
  const group = useContext(HoverCardGroupContext);

  if (group) {
    return (
      <GroupedHoverPopoverTrigger
        group={group}
        label={label}
        trigger={trigger}
        triggerClassName={triggerClassName}
        className={className}
        onOpen={onOpen}
        onPress={onPress}
        working={working}
        inline={inline}
      >
        {children}
      </GroupedHoverPopoverTrigger>
    );
  }

  return (
    <PreviewTrigger
      delay={CARD_OPEN_DELAY_MS}
      closeDelay={CARD_CLOSE_DELAY_MS}
      onOpenChange={(isOpen) => {
        if (isOpen) onOpen?.();
      }}
    >
      {inline ? (
        <PreviewTriggerInline label={label} className={triggerClassName} onPress={onPress}>
          {trigger}
        </PreviewTriggerInline>
      ) : (
        <PreviewTriggerButton
          aria-label={label}
          data-working={working}
          className={triggerClassName}
          onPress={onPress}
        >
          {trigger}
        </PreviewTriggerButton>
      )}
      <Popover
        placement="bottom start"
        offset={12}
        containerPadding={12}
        shouldSkipAnimation={false}
        className={cn(CARD_SURFACE_CLASS, CARD_BRIDGE_CLASS, CARD_MOTION_CLASS, className)}
      >
        <div className="min-w-0 max-h-[min(28rem,calc(100dvh-2rem))] overflow-x-hidden overflow-y-auto rounded-[inherit]">
          {children}
        </div>
      </Popover>
    </PreviewTrigger>
  );
}

function GroupedHoverPopoverTrigger({
  group,
  label,
  trigger,
  triggerClassName,
  className,
  children,
  onOpen,
  onPress,
  working,
  inline,
}: {
  group: HoverCardGroupContextValue;
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  className?: string;
  children: ReactNode;
  onOpen?: () => void;
  onPress?: () => void;
  working?: boolean;
  inline?: boolean;
}) {
  const id = useId();
  const triggerElRef = useRef<HTMLElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    group.register({
      id,
      className,
      triggerEl: triggerElRef.current,
      onOpen: () => onOpenRef.current?.(),
      renderContent: () => childrenRef.current,
    });
  }, [className, group, id, children, inline]);

  useEffect(() => {
    return () => {
      clearLongPress();
      group.unregister(id);
    };
  }, [clearLongPress, group, id]);

  const subscribeExpanded = useCallback(
    (listener: () => void) => group.subscribeActive(id, listener),
    [group, id],
  );
  const getExpanded = useCallback(() => group.isActive(id), [group, id]);
  const isExpanded = useSyncExternalStore(subscribeExpanded, getExpanded, () => false);

  const setRef = useCallback((node: HTMLElement | null) => {
    triggerElRef.current = node;
  }, []);

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      group.pointerEnterTrigger(id, event.clientX, event.clientY);
    },
    [group, id],
  );

  const handlePointerLeave = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      group.pointerLeaveTrigger(id);
    },
    [group, id],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      longPressedRef.current = false;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressedRef.current = true;
        group.openImmediate(id);
      }, TOUCH_LONG_PRESS_MS);
    },
    [clearLongPress, group, id],
  );

  const handlePointerUpOrCancel = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleFocus = useCallback(
    (event: ReactFocusEvent<Element>) => {
      if (
        event.currentTarget instanceof HTMLElement &&
        event.currentTarget.matches(":focus-visible")
      ) {
        group.focusTrigger(id);
      }
    },
    [group, id],
  );

  const handleBlur = useCallback(() => {
    group.blurTrigger(id);
  }, [group, id]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" && !onPress) {
        event.preventDefault();
        group.openImmediate(id);
      }
    },
    [group, id, onPress],
  );

  const handlePress = useCallback(() => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (onPress) {
      group.closeImmediate(false);
      onPress();
    } else {
      group.openImmediate(id);
    }
  }, [group, id, onPress]);

  if (inline) {
    const control = chipControl(handlePress);
    return (
      <span
        ref={setRef}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={isExpanded}
        className={triggerClassName}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...control}
        onKeyDown={(event) => {
          handleKeyDown(event);
          control?.onKeyDown?.(event);
        }}
      >
        {trigger}
      </span>
    );
  }

  return (
    <Button
      ref={setRef}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={isExpanded}
      data-working={working}
      className={triggerClassName}
      onPress={handlePress}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {trigger}
    </Button>
  );
}

const PreviewTriggerButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function PreviewTriggerButton({ onPress, ...props }, ref) {
    const closePreview = useClosePreview();
    const escapeRef = useEscapePassesClosedPeek<HTMLButtonElement>(ref);
    return (
      <Button
        {...props}
        ref={escapeRef}
        onPress={
          onPress &&
          ((event) => {
            closePreview();
            onPress(event);
          })
        }
      />
    );
  },
);

function PreviewTriggerInline({
  label,
  className,
  onPress,
  children,
}: {
  label: string;
  className?: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  const closePreview = useClosePreview();
  const escapeRef = useEscapePassesClosedPeek<HTMLSpanElement>(null);
  const control = chipControl(
    onPress &&
      (() => {
        closePreview();
        onPress();
      }),
  );
  return (
    <Focusable>
      <span ref={escapeRef} aria-label={label} className={className} {...control}>
        {children}
      </span>
    </Focusable>
  );
}

export function useClosePreview(): () => void {
  const preview = useContext(OverlayTriggerStateContext);
  return () => preview?.close();
}

function useEscapePassesClosedPeek<T extends HTMLElement>(forwarded: ForwardedRef<T> | null) {
  const detach = useRef<() => void>(undefined);
  return useCallback(
    (node: T | null) => {
      detach.current?.();
      detach.current = node ? passClosedPeekEscape(node) : undefined;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );
}

function passClosedPeekEscape(trigger: HTMLElement) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
    if (trigger.getAttribute("aria-expanded") === "true") return;
    const parent = trigger.parentElement;
    if (!parent) return;
    event.stopPropagation();
    parent.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  };
  trigger.addEventListener("keydown", onKeyDown);
  return () => trigger.removeEventListener("keydown", onKeyDown);
}
