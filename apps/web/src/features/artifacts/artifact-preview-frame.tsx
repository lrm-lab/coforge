import { useEffectEvent, useLayoutEffect, useRef, type ComponentProps } from "react";
import { FocusScope, UNSAFE_PortalProvider, useFocusManager } from "react-aria";

import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";

export function ArtifactPreviewFrame({
  full,
  onExit,
  children,
  className,
  ...props
}: ComponentProps<"dialog"> & { full: boolean; onExit: () => void }) {
  const frame = useRef<HTMLDialogElement>(null);

  const exitPreview = useEffectEvent(() => {
    const dialog = frame.current;
    if (!dialog?.matches(":modal") || dialog.querySelector(OPEN_OVERLAY_SELECTOR)) return false;
    focusExpandButton(dialog);
    onExit();
    return true;
  });

  useLayoutEffect(() => {
    const dialog = frame.current;
    if (!dialog) return;
    if (!full) {
      dialog.open = true;
      return;
    }
    dialog.open = false;
    dialog.showModal();
    focusExpandButton(dialog);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat)
        return;
      if (exitPreview()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      dialog.close();
      dialog.open = true;
      focusExpandButton(dialog);
    };
  }, [full]);

  return (
    <dialog
      {...props}
      ref={frame}
      data-artifact-preview=""
      role={full ? "dialog" : "region"}
      aria-modal={full || undefined}
      className={cn("m-0 h-auto max-h-none max-w-none border-0 p-0 text-inherit", className)}
      onClose={(event) => {
        if (!full && event.target === event.currentTarget) focusExpandButton(event.currentTarget);
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!event.currentTarget.querySelector(OPEN_OVERLAY_SELECTOR)) onExit();
      }}
    >
      <UNSAFE_PortalProvider getContainer={full ? () => frame.current : null}>
        <FocusScope contain={full}>
          {full && <FocusBoundary start />}
          {children}
          {full && <FocusBoundary />}
        </FocusScope>
      </UNSAFE_PortalProvider>
    </dialog>
  );
}

function FocusBoundary({ start = false }: { start?: boolean }) {
  const manager = useFocusManager();
  return (
    <span
      className="sr-only"
      tabIndex={0}
      data-preview-boundary=""
      onFocus={() => {
        const options = {
          tabbable: true,
          accept: (node: Element) => !node.hasAttribute("data-preview-boundary"),
        };
        if (start) manager?.focusLast(options);
        else manager?.focusFirst(options);
      }}
    />
  );
}

function focusExpandButton(dialog: HTMLDialogElement) {
  dialog.querySelector<HTMLElement>("[data-artifact-expand]")?.focus({ preventScroll: true });
}
