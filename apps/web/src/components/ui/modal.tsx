import { useContext, useEffect, type ComponentProps, type CSSProperties } from "react";
import { OverlayTriggerStateContext } from "react-aria-components";

import { ModalOverlay as OfficialModalOverlay } from "#src/components/application/modals/modal";

// The rest of the official modal set, unchanged, so a dialog imports all of it from here.
export { Dialog, DialogTrigger, Modal } from "#src/components/application/modals/modal";
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
  ...props
}: Omit<ComponentProps<typeof OfficialModalOverlay>, "style">) {
  // A dialog inside a `DialogTrigger` gets its open state from the trigger, not from `isOpen`.
  const trigger = useContext(OverlayTriggerStateContext);
  // Only an open dialog follows the viewport; a closed one renders nothing that needs it.
  const open = props.isOpen ?? trigger?.isOpen ?? false;
  const viewportTop = useVisualViewportTop(open);
  const keyboardMayBeUp = useKeyboardFieldFocused(open);
  useKeepFocusedFieldInView(open);
  return (
    <OfficialModalOverlay
      {...props}
      style={{ "--visual-viewport-top": `${viewportTop}px` } as CSSProperties}
      className={(state) =>
        cx(
          "max-sm:top-(--visual-viewport-top) max-sm:bottom-auto max-sm:h-(--visual-viewport-height) max-sm:min-h-0",
          // No keyboard can be up: the visual viewport is the whole screen, whatever was last
          // reported. `!important` outranks the inline values React Aria and this component set,
          // so the dialogs inside (their `max-h`, a lightbox's height) read the same.
          !keyboardMayBeUp &&
            "max-sm:[--visual-viewport-height:100dvh]! max-sm:[--visual-viewport-top:0px]!",
          typeof className === "function" ? className(state) : className,
        )
      }
    />
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
