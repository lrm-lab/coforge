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

// The rest of the official modal set, unchanged, so a dialog imports all of it from here.
export { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useKeyboardFieldFocused } from "#src/hooks/use-keyboard-field-focused";
import { useVisualViewportTop } from "#src/hooks/use-visual-viewport-top";
import { cx } from "#src/utils/cx";

/**
 * The official `ModalOverlay`, placed over the visual viewport on a phone while a field has focus.
 * iOS Safari and Android Chrome do not shrink the layout viewport for the on-screen keyboard, and
 * `dvh` does not follow it either (nor does iOS support `interactive-widget=resizes-content`), so
 * the official overlay (`fixed inset-0`) keeps filling the screen and a dialog at its bottom ends
 * up behind the keyboard, field and all. Here it sits at the visual viewport's offset with React
 * Aria's `--visual-viewport-height`, so the dialog stays right above the keyboard. While no field
 * has focus no keyboard can be up, and both read as the whole screen: iOS does not always report
 * the visual viewport growing back when the keyboard goes away (a dialog opened while the page's
 * own field had the keyboard up stayed at the keyboard's height, the page showing under it).
 * Every dialog uses this one.
 */
export function ModalOverlay({
  className,
  confirmation,
  ...props
}: Omit<ComponentProps<typeof OfficialModalOverlay>, "style"> & {
  /** A short question that interrupts (a confirmation): on a phone, a sheet along the bottom edge
   * that a drag on its grabber or a tap above it dismisses, with its buttons stacked full width (Frank, 11-17, task
   * #137, direction B). */
  confirmation?: boolean;
}) {
  // A dialog inside a `DialogTrigger` gets its open state from the trigger, not from `isOpen`.
  const trigger = useContext(OverlayTriggerStateContext);
  // Only an open dialog follows the viewport; a closed one renders nothing that needs it.
  const open = props.isOpen ?? trigger?.isOpen ?? false;
  const viewportTop = useVisualViewportTop(open);
  const keyboardMayBeUp = useKeyboardFieldFocused(open);
  const wide = useBreakpoint("sm");
  useKeepFocusedFieldInView(open);
  return (
    <ConfirmationSheetContext.Provider value={Boolean(confirmation)}>
      <OfficialModalOverlay
        {...props}
        // A tap above a confirmation's phone sheet closes it, as a pull on its grabber does; the
        // caller's close ignores both while its change runs.
        isDismissable={props.isDismissable ?? (Boolean(confirmation) && !wide)}
        style={
          {
            "--visual-viewport-top": `${viewportTop}px`,
            // A full-screen dialog keeps the home indicator clear (styles.css), but not above an
            // on-screen keyboard, which covers the indicator: the inset shrinks by however much the
            // keyboard takes off the visual viewport. A focused field alone is no sign, as iOS
            // raises no keyboard for a field focused without a tap.
            "--spacing-safe-bottom":
              "max(0px, calc(env(safe-area-inset-bottom, 0px) - (100dvh - var(--visual-viewport-height, 100dvh))))",
          } as CSSProperties
        }
        className={(state) =>
          cx(
            "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
            // No keyboard can be up: the visual viewport is the whole screen, whatever was last
            // reported. `!important` outranks the inline values React Aria and this component set,
            // so the dialogs inside (their `max-h`, a lightbox's height) read the same.
            !keyboardMayBeUp &&
              "max-sm:[--visual-viewport-height:100dvh]! max-sm:[--visual-viewport-top:0px]!",
            // A confirmation reaches the screen's edges on a phone: no gutter, nothing under it.
            confirmation && "max-sm:px-0 max-sm:[--modal-pb:0px]",
            typeof className === "function" ? className(state) : className,
          )
        }
      />
    </ConfirmationSheetContext.Provider>
  );
}

/** Whether the overlay around is a confirmation (`ModalOverlay`'s `confirmation`). */
const ConfirmationSheetContext = createContext(false);

/** Whether this sits in a confirmation shown as a phone's bottom sheet. */
export function useConfirmationSheet(): boolean {
  const wide = useBreakpoint("sm");
  return useContext(ConfirmationSheetContext) && !wide;
}

/**
 * The official `Modal`. In a confirmation on a phone it is a sheet: edge to edge along the bottom,
 * rising from it and leaving the same way, with a grabber on top; its close button (marked
 * `data-dialog-close`) gives way to the grabber and Cancel, and its button row
 * (`data-dialog-actions`) stacks full width, the action above Cancel, in the thumb's reach.
 */
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
          // The exit keyframe has no start, so a sheet let go mid-drag leaves from where it is.
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

/**
 * Whether a released drag dismisses a sheet: pulled down past a third of its height, or flicked
 * down (faster than 0.5px/ms) however short the pull.
 */
export function dragDismisses(offset: number, velocity: number, height: number): boolean {
  return offset > height / 3 || (offset > 8 && velocity > 0.5);
}

/** How far back the velocity of a released drag looks, in ms. */
const VELOCITY_WINDOW_MS = 100;

/**
 * A phone sheet's grabber, a 44px strip along its top: the sheet follows the finger 1:1 down (and a
 * fifth of the way up, as resistance), and on release either closes, through the overlay's own
 * close so a confirmation that cannot close yet (its change running) refuses as it does to Cancel,
 * or settles back. Hidden from assistive technology and the keyboard, which close through Cancel
 * and Escape.
 */
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
    // Reduced motion zeroes the exit's travel (styles.css), which would carry the sheet back up as
    // it fades: it goes where it was let go instead.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      sheet.style.animation = "none";
    state.close();
    // Refused (a change still running): the sheet is still open and comes back.
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

/**
 * While a dialog is open, brings its focused field back into view whenever the dialog resizes: the
 * keyboard coming up shrinks the visual viewport and so the dialog, and a field inside its
 * scrolling content can end up below the fold of that content, where the browser does not always
 * scroll to it. The dialog is watched from the viewport's first resize, once it has laid out.
 */
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
    // Only the dialog that holds focus now: a nested or swapped dialog replaces the last one.
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
