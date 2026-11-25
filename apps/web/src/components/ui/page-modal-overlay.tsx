import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FocusScope } from "react-aria";
import { OverlayTriggerStateContext } from "react-aria-components";
import { useOverlayTriggerState, type OverlayTriggerState } from "react-stately";

import {
  Modal as OfficialModal,
  ModalOverlay as OfficialModalOverlay,
} from "#src/components/application/modals/modal";
import { OVERLAY_LAYER, OVERLAY_SCRIM_Z } from "#src/lib/overlay-layer";
import { acquirePageFlowHandoff, isTopPageFlowEntry } from "#src/lib/page-flow-handoff";
import { cx } from "#src/utils/cx";

export type ModalForm = "sheet" | "page" | "page-flow" | null;

export const ModalContext = createContext<{ form: ModalForm; instant: boolean }>({
  form: null,
  instant: false,
});

export function resolveScrimConfig(
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

export function PhonePageFlowOverlay({
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

export function PageFlowModal({
  className,
  children,
  ...props
}: ComponentProps<typeof OfficialModal>) {
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

export function useKeepFocusedFieldInView(open: boolean) {
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
