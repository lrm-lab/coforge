import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FocusScope } from "react-aria";
import {
  OverlayTriggerStateContext,
  type ModalOverlay as AriaModalOverlay,
} from "react-aria-components";
import { useOverlayTriggerState, type OverlayTriggerState } from "react-stately";

import {
  Modal as OfficialModal,
  ModalOverlay as OfficialModalOverlay,
} from "#src/components/application/modals/modal";

export { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useKeyboardFieldFocused } from "#src/hooks/use-keyboard-field-focused";
import { useVisualViewportTop } from "#src/hooks/use-visual-viewport-top";
import {
  composeOverlayRefs,
  OVERLAY_CONTENT_Z,
  OVERLAY_LAYER,
  OVERLAY_SCRIM_Z,
  useOverlayHost,
} from "#src/lib/overlay-layer";
import { acquirePageFlowHandoff, isTopPageFlowEntry } from "#src/lib/page-flow-handoff";
import { cx } from "#src/utils/cx";

type ModalForm = "sheet" | "page" | "page-flow" | null;

const RefForwardingModalOverlay: (
  props: ComponentPropsWithRef<typeof AriaModalOverlay>,
) => ReactNode = OfficialModalOverlay;

const ModalContext = createContext<{ form: ModalForm; instant: boolean }>({
  form: null,
  instant: false,
});

function resolveScrimConfig(
  className: ComponentProps<typeof OfficialModalOverlay>["className"],
  instant: boolean,
): { enabled: boolean; className: string } {
  const staticClass = typeof className === "string" ? className : "";
  if (staticClass.includes("bg-transparent")) {
    return { enabled: false, className: "" };
  }
  const hasLightOverlay = staticClass.includes("bg-overlay/30");
  const noBlur = staticClass.includes("backdrop-blur-none");
  return {
    enabled: true,
    className: cx(
      hasLightOverlay ? "bg-overlay/30" : "bg-modal-scrim/70",
      !noBlur && "backdrop-blur-[6px]",
      !instant && "motion-enter animate-in fade-in scrim-in",
    ),
  };
}

/* Safari 26+ paints a flat strip behind its bottom toolbar when a fixed scrim reaches the window foot.
   Positioning the scrim in page coordinates lets Safari render the dimmed page behind the toolbar. */
export function PageCoordinateScrim({
  open,
  className,
  portalContainer,
  zIndex = OVERLAY_SCRIM_Z,
}: {
  open: boolean;
  className: string;
  portalContainer?: HTMLElement | null;
  zIndex?: number;
}) {
  const [box, setBox] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;
    const sync = () => {
      const top = Math.max(0, window.scrollY);
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        window.innerHeight,
      );
      const height = Math.max(
        window.innerHeight,
        Math.min(docHeight - top, window.innerHeight * 1.25),
      );
      setBox({ top, height });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, { passive: true });
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden="true"
      data-page-scrim=""
      style={{
        top: `${box.top}px`,
        height: box.height > 0 ? `${box.height}px` : "100dvh",
        zIndex,
      }}
      className={cx("pointer-events-auto absolute inset-x-0", className)}
    />,
    portalContainer ?? document.body,
  );
}

function PhonePageFlowOverlay({
  open,
  instant,
  state,
  isKeyboardDismissDisabled,
  onClose,
  children,
}: {
  open: boolean;
  instant: boolean;
  state: OverlayTriggerState;
  isKeyboardDismissDisabled?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef<symbol | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const modalContext = useMemo<{ form: ModalForm; instant: boolean }>(
    () => ({ form: "page-flow", instant }),
    [instant],
  );

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") return;
    const handoff = acquirePageFlowHandoff({
      root: document.getElementById("coforge-app-root"),
      win: window,
      layerEl: layerRef.current,
    });
    entryIdRef.current = handoff.id;
    return () => {
      entryIdRef.current = null;
      handoff.release();
    };
  }, [open]);

  useEffect(() => {
    if (!open || isKeyboardDismissDisabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (entryIdRef.current && !isTopPageFlowEntry(entryIdRef.current)) return;
      const layer = layerRef.current;
      if (layer && document.querySelector("[data-page-scrim]")) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, isKeyboardDismissDisabled]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <OverlayTriggerStateContext.Provider value={state}>
      <ModalContext.Provider value={modalContext}>
        <FocusScope contain restoreFocus autoFocus>
          <div
            ref={layerRef}
            data-phone-page-flow=""
            className={`relative ${OVERLAY_LAYER} flex min-h-dvh w-full flex-col bg-primary safe-area-padding`}
          >
            {children}
          </div>
        </FocusScope>
      </ModalContext.Provider>
    </OverlayTriggerStateContext.Provider>,
    document.body,
  );
}

export function ModalOverlay({
  className,
  confirmation,
  page,
  instant = false,
  ref,
  UNSTABLE_portalContainer,
  ...props
}: Omit<ComponentProps<typeof RefForwardingModalOverlay>, "style"> & {
  confirmation?: boolean;
  page?: boolean;
  instant?: boolean;
}) {
  const trigger = useContext(OverlayTriggerStateContext);
  const usesLocalState = props.isOpen !== undefined || props.defaultOpen !== undefined || !trigger;
  const localState = useOverlayTriggerState({
    isOpen: props.isOpen,
    defaultOpen: props.defaultOpen,
    onOpenChange: props.onOpenChange,
  });
  const overlayState = usesLocalState ? localState : trigger;
  const open = overlayState.isOpen;
  const wide = useBreakpoint("sm");
  const usePhonePageFlow = Boolean(page) && !wide;
  const { host, overlayRef } = useOverlayHost(open && !usePhonePageFlow);
  const viewportTop = useVisualViewportTop(open && !usePhonePageFlow);
  const keyboardMayBeUp = useKeyboardFieldFocused(open && !usePhonePageFlow);
  const form: ModalForm = confirmation ? "sheet" : page ? "page" : null;
  const modalContext = useMemo(() => ({ form, instant }), [form, instant]);
  const scrim = useMemo(() => resolveScrimConfig(className, instant), [className, instant]);
  useKeepFocusedFieldInView(open && !usePhonePageFlow);

  if (usePhonePageFlow) {
    const close = () => {
      overlayState.close();
    };
    const resolvedChildren =
      typeof props.children === "function"
        ? props.children({
            isEntering: false,
            isExiting: false,
            state: overlayState,
            defaultChildren: undefined,
          })
        : props.children;
    return (
      <PhonePageFlowOverlay
        open={open}
        instant={instant}
        state={overlayState}
        isKeyboardDismissDisabled={props.isKeyboardDismissDisabled}
        onClose={close}
      >
        {resolvedChildren}
      </PhonePageFlowOverlay>
    );
  }

  return (
    <ModalContext.Provider value={modalContext}>
      {scrim.enabled && (
        <PageCoordinateScrim
          open={open}
          portalContainer={host}
          zIndex={OVERLAY_SCRIM_Z}
          className={scrim.className}
        />
      )}
      <RefForwardingModalOverlay
        {...props}
        ref={composeOverlayRefs(ref, overlayRef)}
        UNSTABLE_portalContainer={UNSTABLE_portalContainer ?? host ?? undefined}
        isOpen={usesLocalState ? overlayState.isOpen : undefined}
        defaultOpen={undefined}
        onOpenChange={usesLocalState ? overlayState.setOpen : props.onOpenChange}
        isDismissable={props.isDismissable ?? (Boolean(confirmation) && !wide)}
        style={
          {
            zIndex: OVERLAY_CONTENT_Z,
            "--visual-viewport-top": `${viewportTop}px`,
            "--spacing-safe-bottom":
              "max(0px, calc(env(safe-area-inset-bottom, 0px) - (var(--app-height, 100dvh) - var(--visual-viewport-height, var(--app-height, 100dvh)))))",
          } as CSSProperties
        }
        className={(state) =>
          cx(
            /* Safari 26+ samples fixed overlays that touch the viewport foot; hide the fixed shell
               with visibility: hidden while PageCoordinateScrim dims the page in page coordinates. */
            "invisible z-10 bg-transparent backdrop-blur-none",
            instant && "animate-none!",
            "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
            !keyboardMayBeUp &&
              "max-sm:[--visual-viewport-height:var(--app-height,100dvh)]! max-sm:[--visual-viewport-top:0px]!",
            confirmation && "max-sm:px-0 max-sm:[--modal-pb:0px]",
            page &&
              "max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px]",
            typeof className === "function" ? className(state) : className,
            "invisible z-10 bg-transparent backdrop-blur-none",
          )
        }
      />
    </ModalContext.Provider>
  );
}

export function useConfirmationSheet(): boolean {
  const wide = useBreakpoint("sm");
  return useContext(ModalContext).form === "sheet" && !wide;
}

function PageFlowModal({ className, children, ...props }: ComponentProps<typeof OfficialModal>) {
  const triggerState = useContext(OverlayTriggerStateContext);
  const fallbackState = useOverlayTriggerState({ isOpen: true });
  const state = triggerState ?? fallbackState;
  const resolvedClass =
    typeof className === "function"
      ? className({
          isEntering: false,
          isExiting: false,
          state,
          defaultClassName: undefined,
        })
      : className;
  const resolvedChildren =
    typeof children === "function"
      ? children({
          isEntering: false,
          isExiting: false,
          state,
          defaultChildren: undefined,
        })
      : children;
  const {
    isDismissable: _isDismissable,
    isKeyboardDismissDisabled: _isKeyboardDismissDisabled,
    isOpen: _isOpen,
    defaultOpen: _defaultOpen,
    onOpenChange: _onOpenChange,
    isEntering: _isEntering,
    isExiting: _isExiting,
    shouldCloseOnInteractOutside: _shouldCloseOnInteractOutside,
    UNSTABLE_portalContainer: _portalContainer,
    style,
    ...domProps
  } = props;
  const resolvedStyle =
    typeof style === "function"
      ? style({
          isEntering: false,
          isExiting: false,
          state,
          defaultStyle: {},
        })
      : style;
  return (
    <div
      {...(domProps as React.HTMLAttributes<HTMLDivElement>)}
      style={resolvedStyle}
      className={cx(
        "visible flex w-full flex-1 flex-col bg-primary",
        resolvedClass,
        "h-auto max-h-none max-w-none overflow-visible rounded-none shadow-none ring-0",
      )}
    >
      {resolvedChildren}
    </div>
  );
}

export function Modal({ className, children, ...props }: ComponentProps<typeof OfficialModal>) {
  const { form, instant } = useContext(ModalContext);

  if (form === "page-flow") {
    return (
      <PageFlowModal className={className} {...props}>
        {children}
      </PageFlowModal>
    );
  }

  if (form !== "sheet")
    return (
      <OfficialModal
        {...props}
        className={(state) =>
          cx(
            "visible rounded-4xl sm:rounded-4xl ring-1 ring-modal-edge",
            instant
              ? "animate-none!"
              : [state.isEntering && "sm:fade-in", state.isExiting && "fade-out"],
            typeof className === "function" ? className(state) : className,
            form === "page" &&
              "max-sm:h-full max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:ring-0 max-sm:safe-area-padding",
          )
        }
      >
        {children}
      </OfficialModal>
    );
  return (
    <OfficialModal
      {...props}
      className={(state) =>
        cx(
          "visible rounded-4xl sm:rounded-4xl ring-1 ring-modal-edge",
          instant
            ? "animate-none!"
            : [
                state.isEntering && "sm:fade-in max-sm:motion-enter-lg",
                state.isExiting && "sm:fade-out max-sm:motion-leave-lg",
              ],
          typeof className === "function" ? className(state) : className,
          "max-sm:relative max-sm:w-full max-sm:max-w-none max-sm:rounded-t-4xl max-sm:rounded-b-none max-sm:pb-safe-bottom",
          "max-sm:zoom-in-100 max-sm:zoom-out-100 max-sm:slide-in-from-bottom max-sm:slide-out-to-bottom",
          "max-sm:[&_[data-dialog-close]]:hidden",
          "max-sm:[&_[data-dialog-actions]]:flex-col-reverse max-sm:[&_[data-dialog-actions]]:items-stretch",
        )
      }
    >
      {(state) => (
        <>
          <SheetGrabber />
          {typeof children === "function" ? children(state) : children}
        </>
      )}
    </OfficialModal>
  );
}

export function dragDismisses(offset: number, velocity: number, height: number): boolean {
  return offset > height / 3 || (offset > 8 && velocity > 0.5);
}

const VELOCITY_WINDOW_MS = 100;

export function SheetGrabber({ className }: { className?: string }) {
  const state = useContext(OverlayTriggerStateContext);
  const drag = useRef<{
    pointer: number;
    startY: number;
    offset: number;
    samples: { t: number; y: number }[];
  } | null>(null);
  const sheetOf = (grabber: Element) => grabber.parentElement as HTMLElement;

  function settle(sheet: HTMLElement) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sheet.style.transition = reduced
      ? "transform 150ms var(--ease-out)"
      : "transform calc(var(--duration-md) * 1.5) var(--ease-spring)";
    sheet.style.transform = "";
    sheet.style.animation = "";
  }

  function release(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    const sheet = sheetOf(event.currentTarget);
    const first = current.samples[0]!;
    const elapsed = event.timeStamp - first.t;
    const velocity = elapsed > 0 ? (event.clientY - first.y) / elapsed : 0;
    if (
      event.type !== "pointerup" ||
      !state ||
      !dragDismisses(current.offset, velocity, sheet.offsetHeight)
    ) {
      settle(sheet);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      sheet.style.animation = "none";
    state.close();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (sheet.isConnected && !sheet.hasAttribute("data-exiting")) settle(sheet);
      }),
    );
  }

  return (
    <div
      aria-hidden="true"
      data-sheet-grabber
      className={cx(
        "absolute inset-x-0 top-0 z-10 flex h-11 cursor-grab touch-none justify-center sm:hidden",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          startY: event.clientY,
          offset: 0,
          samples: [{ t: event.timeStamp, y: event.clientY }],
        };
        sheetOf(event.currentTarget).style.transition = "none";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        const pulled = event.clientY - current.startY;
        current.offset = pulled > 0 ? pulled : pulled / 5;
        sheetOf(event.currentTarget).style.transform = `translateY(${current.offset}px)`;
        current.samples.push({ t: event.timeStamp, y: event.clientY });
        while (
          current.samples.length > 2 &&
          event.timeStamp - current.samples[0]!.t > VELOCITY_WINDOW_MS
        )
          current.samples.shift();
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span className="mt-2 h-1 w-10 rounded-full bg-fg-quaternary" />
    </div>
  );
}

function useKeepFocusedFieldInView(open: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;
    let dialog: Element | null | undefined;
    const reveal = () => {
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        dialog?.contains(field) &&
        field.matches("input, textarea, [contenteditable]")
      )
        field.scrollIntoView({ block: "nearest" });
    };
    const resized = new ResizeObserver(reveal);
    const watch = () => {
      dialog = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]');
      resized.disconnect();
      if (dialog) resized.observe(dialog);
    };
    viewport.addEventListener("resize", watch);
    return () => {
      viewport.removeEventListener("resize", watch);
      resized.disconnect();
    };
  }, [open]);
}
