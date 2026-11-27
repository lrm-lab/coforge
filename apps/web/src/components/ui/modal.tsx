import {
  useContext,
  useMemo,
  useRef,
  type ComponentProps,
  type ComponentPropsWithRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
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
  OVERLAY_SCRIM_Z,
  useOverlayHost,
} from "#src/lib/overlay-layer";
import { cx } from "#src/utils/cx";
import {
  ModalContext,
  PageCoordinateScrim,
  PageModalContext,
  resolveScrimConfig,
  UnifiedPageModal,
  UnifiedPageModalOverlay,
  useKeepFocusedFieldInView,
  type ModalForm,
  type ModalOverlayProps,
} from "./page-modal-overlay";

export { PageCoordinateScrim } from "./page-modal-overlay";

const RefForwardingModalOverlay: (
  props: ComponentPropsWithRef<typeof AriaModalOverlay>,
) => ReactNode = OfficialModalOverlay;

export function ModalOverlay({
  className,
  confirmation,
  page,
  instant = false,
  ref,
  UNSTABLE_portalContainer,
  ...props
}: ModalOverlayProps) {
  const trigger = useContext(OverlayTriggerStateContext);
  const usesLocalState = props.isOpen !== undefined || props.defaultOpen !== undefined || !trigger;
  const localState = useOverlayTriggerState({
    isOpen: props.isOpen,
    defaultOpen: props.defaultOpen,
    onOpenChange: props.onOpenChange,
  });
  const overlayState = usesLocalState ? localState : trigger;
  const wide = useBreakpoint("sm");

  if (page) {
    return (
      <UnifiedPageModalOverlay
        {...props}
        className={className}
        instant={instant}
        overlayState={overlayState}
        wide={wide}
        ref={ref}
        UNSTABLE_portalContainer={UNSTABLE_portalContainer}
      />
    );
  }

  return (
    <StandardModalOverlay
      {...props}
      className={className}
      confirmation={confirmation}
      instant={instant}
      overlayState={overlayState}
      usesLocalState={usesLocalState}
      wide={wide}
      ref={ref}
      UNSTABLE_portalContainer={UNSTABLE_portalContainer}
    />
  );
}

function StandardModalOverlay({
  className,
  confirmation,
  instant = false,
  overlayState,
  usesLocalState,
  wide,
  ref,
  UNSTABLE_portalContainer,
  ...props
}: ModalOverlayProps & {
  overlayState: OverlayTriggerState;
  usesLocalState: boolean;
  wide: boolean;
}) {
  const open = overlayState.isOpen;
  const { host, overlayRef } = useOverlayHost(open);
  const viewportTop = useVisualViewportTop(open);
  const keyboardMayBeUp = useKeyboardFieldFocused(open);
  const form: ModalForm = confirmation ? "sheet" : null;
  const modalContext = useMemo(() => ({ form, instant }), [form, instant]);
  const scrim = useMemo(() => resolveScrimConfig(className, instant), [className, instant]);
  useKeepFocusedFieldInView(open);

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
            instant
              ? "animate-none!"
              : [state.isEntering && "scrim-in", state.isExiting && "scrim-out"],
            "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
            !keyboardMayBeUp &&
              "max-sm:[--visual-viewport-height:var(--app-height,100dvh)]! max-sm:[--visual-viewport-top:0px]!",
            confirmation && "max-sm:px-0 max-sm:[--modal-pb:0px]",
            !confirmation &&
              "max-sm:[--modal-pt:max(16px,var(--spacing-safe-top))] max-sm:[--modal-pb:calc(16px+var(--spacing-safe-bottom))]",
            typeof className === "function" ? className(state) : className,
            "max-sm:visible sm:invisible z-10 bg-transparent backdrop-blur-none",
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

export function Modal({ className, children, ...props }: ComponentProps<typeof OfficialModal>) {
  const { form, instant } = useContext(ModalContext);
  const pageModal = useContext(PageModalContext);

  if (pageModal) {
    return (
      <UnifiedPageModal pageModal={pageModal} instant={instant} className={className} {...props}>
        {children}
      </UnifiedPageModal>
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
