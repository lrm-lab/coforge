import type { ReactNode, RefObject } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { cx } from "#src/utils/cx";
import type { TaskDetent } from "./task-detent-physics";
import { useTaskDetentSheet } from "./use-task-detent-sheet";

export type { TaskDetent } from "./task-detent-physics";

export type TaskDetentSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detent?: TaskDetent;
  defaultDetent?: TaskDetent;
  onDetentChange?: (detent: TaskDetent) => void;
  ariaLabel: string;
  header: ReactNode;
  children: ReactNode;
  composer?: ReactNode;
  autoExpandOnComposerFocus?: boolean;
  keyboardDismiss?: boolean;
  dismissRef?: RefObject<(() => void) | null>;
};

export function TaskDetentSheet({
  open,
  onOpenChange,
  detent,
  defaultDetent = "half",
  onDetentChange,
  ariaLabel,
  header,
  children,
  composer,
  autoExpandOnComposerFocus = true,
  keyboardDismiss = true,
  dismissRef,
}: TaskDetentSheetProps): ReactNode {
  const {
    effectiveDetent,
    lifecycle,
    rendered,
    attachSheetRef,
    scrimRef,
    bodyRef,
    composerRef,
    requestDismiss,
    handleGrabPointerDown,
    handleGrabPointerMove,
    finishGrabDrag,
    handleComposerFocusCapture,
    handleBodyScrollCapture,
  } = useTaskDetentSheet({
    open,
    onOpenChange,
    detent,
    defaultDetent,
    onDetentChange,
    autoExpandOnComposerFocus,
    dismissRef,
  });

  return (
    <ModalOverlay
      isOpen={rendered}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestDismiss();
      }}
      isDismissable={false}
      isKeyboardDismissDisabled={!keyboardDismiss}
      instant
      className="items-end justify-center overflow-clip bg-transparent px-0 backdrop-blur-none [--modal-pb:0rem] [--modal-pt:0rem] max-sm:px-0 max-sm:[--modal-pb:0rem] max-sm:[--modal-pt:0rem] sm:items-end sm:px-0 sm:[--modal-pb:0rem] sm:[--modal-pt:0rem]"
    >
      <Modal className="pointer-events-none relative z-10 flex h-[94%] max-h-[94%] w-full max-w-none flex-col overflow-visible rounded-none bg-transparent shadow-none ring-0 max-sm:overflow-visible sm:rounded-none">
        <div
          ref={scrimRef}
          aria-hidden="true"
          data-detent-scrim=""
          data-dragging="false"
          onClick={requestDismiss}
          style={{ opacity: 0 }}
          className={cx(
            "visible fixed inset-0 z-0 bg-modal-scrim will-change-[opacity]",
            lifecycle === "exiting" ? "pointer-events-none" : "pointer-events-auto",
          )}
        />
        <div
          ref={attachSheetRef}
          data-detent-sheet=""
          data-detent={effectiveDetent}
          data-dragging="false"
          style={{ transform: "translate3d(0, 100%, 0)" }}
          className="group/sheet visible pointer-events-auto relative z-10 flex h-full w-full flex-col overflow-visible rounded-t-[1.25rem] bg-primary shadow-2xl ring-1 ring-secondary will-change-transform after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-16 after:bg-primary after:content-['']"
        >
          <Dialog
            aria-label={ariaLabel}
            className="flex max-h-none min-h-0 flex-1 flex-col overflow-visible outline-hidden"
          >
            <div
              data-detent-grab=""
              onPointerDown={handleGrabPointerDown}
              onPointerMove={handleGrabPointerMove}
              onPointerUp={(event) => finishGrabDrag(event, false)}
              onPointerCancel={(event) => finishGrabDrag(event, true)}
              className="shrink-0 cursor-grab touch-pan-x rounded-t-[1.25rem] border-b border-secondary bg-primary pt-2 pb-1.5 select-none active:cursor-grabbing"
            >
              <div
                aria-hidden="true"
                className="mx-auto flex h-3 w-full items-center justify-center"
              >
                <span className="h-1 w-9 rounded-full bg-border-primary transition-[width,background-color] duration-200 ease-out group-data-[dragging=true]/sheet:w-11 group-data-[dragging=true]/sheet:bg-fg-tertiary" />
              </div>
              <div className="flex min-h-11 items-center px-3">{header}</div>
            </div>
            <div
              ref={bodyRef}
              data-detent-body=""
              onScrollCapture={handleBodyScrollCapture}
              onFocusCapture={handleComposerFocusCapture}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
            >
              {children}
            </div>
            {composer != null && (
              <div
                ref={composerRef}
                data-detent-composer=""
                onFocusCapture={handleComposerFocusCapture}
                className="relative z-10 shrink-0 border-t border-secondary bg-primary pb-safe-bottom will-change-transform"
              >
                {composer}
              </div>
            )}
          </Dialog>
        </div>
      </Modal>
    </ModalOverlay>
  );
}
