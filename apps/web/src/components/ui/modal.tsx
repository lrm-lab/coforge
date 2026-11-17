import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { OverlayTriggerStateContext } from "react-aria-components";

import {
  Modal as OfficialModal,
  ModalOverlay as OfficialModalOverlay,
} from "#src/components/application/modals/modal";

export { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useKeyboardFieldFocused } from "#src/hooks/use-keyboard-field-focused";
import { useVisualViewportTop } from "#src/hooks/use-visual-viewport-top";
import { cx } from "#src/utils/cx";

export function ModalOverlay({
  className,
  confirmation,
  ...props
}: Omit<ComponentProps<typeof OfficialModalOverlay>, "style"> & {
  confirmation?: boolean;
}) {
  const trigger = useContext(OverlayTriggerStateContext);
  const open = props.isOpen ?? trigger?.isOpen ?? false;
  const viewportTop = useVisualViewportTop(open);
  const keyboardMayBeUp = useKeyboardFieldFocused(open);
  const wide = useBreakpoint("sm");
  useKeepFocusedFieldInView(open);
  return (
    <ConfirmationSheetContext.Provider value={Boolean(confirmation)}>
      <OfficialModalOverlay
        {...props}
        isDismissable={props.isDismissable ?? (Boolean(confirmation) && !wide)}
        style={
          {
            "--visual-viewport-top": `${viewportTop}px`,
            "--spacing-safe-bottom":
              "max(0px, calc(env(safe-area-inset-bottom, 0px) - (100dvh - var(--visual-viewport-height, 100dvh))))",
          } as CSSProperties
        }
        className={(state) =>
          cx(
            "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
            !keyboardMayBeUp &&
              "max-sm:[--visual-viewport-height:100dvh]! max-sm:[--visual-viewport-top:0px]!",
            confirmation && "max-sm:px-0 max-sm:[--modal-pb:0px]",
            typeof className === "function" ? className(state) : className,
          )
        }
      />
    </ConfirmationSheetContext.Provider>
  );
}

const ConfirmationSheetContext = createContext(false);

export function useConfirmationSheet(): boolean {
  const wide = useBreakpoint("sm");
  return useContext(ConfirmationSheetContext) && !wide;
}

export function Modal({ className, children, ...props }: ComponentProps<typeof OfficialModal>) {
  const confirmation = useContext(ConfirmationSheetContext);
  if (!confirmation)
    return (
      <OfficialModal {...props} className={className}>
        {children}
      </OfficialModal>
    );
  return (
    <OfficialModal
      {...props}
      className={(state) =>
        cx(
          typeof className === "function" ? className(state) : className,
          "max-sm:relative max-sm:w-full max-sm:max-w-none max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-safe-bottom",
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

function SheetGrabber() {
  const state = useContext(OverlayTriggerStateContext);
  const drag = useRef<{
    pointer: number;
    startY: number;
    offset: number;
    samples: { t: number; y: number }[];
  } | null>(null);
  const sheetOf = (grabber: Element) => grabber.parentElement as HTMLElement;

  function settle(sheet: HTMLElement) {
    sheet.style.transition = "transform var(--motion-in) var(--ease-snap)";
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
      className="absolute inset-x-0 top-0 z-10 flex h-11 cursor-grab touch-none justify-center sm:hidden"
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
