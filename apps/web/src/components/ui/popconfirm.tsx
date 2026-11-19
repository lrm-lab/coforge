import { useState, type ReactNode } from "react";
import { Heading, Popover, Text, type PopoverProps } from "react-aria-components";

import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

const POPOVER_EXIT_SETTLE_MS = 200;

export function Popconfirm({
  title,
  description,
  confirmLabel,
  pendingLabel,
  errorMessage,
  onConfirm,
  placement = "bottom",
  cancelLabel,
  tone = "destructive",
  isDisabled = false,
  fallbackFocus,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  pendingLabel?: string;
  errorMessage: string | ((cause: unknown) => string);
  onConfirm: () => Promise<void>;
  placement?: PopoverProps["placement"];
  cancelLabel?: string;
  tone?: "destructive" | "final";
  isDisabled?: boolean;
  fallbackFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, guard] = useSubmitGuard();
  const phone = !useBreakpoint("sm");
  if (isDisabled && open) setOpen(false);

  function focusFallbackOnceSettled() {
    if (!fallbackFocus) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      fallbackFocus()?.focus({ preventScroll: true });
    }, POPOVER_EXIT_SETTLE_MS);
  }

  const content = (
    <Dialog className="outline-none">
      {({ close }) => (
        <div className="flex flex-col gap-3 p-4 max-sm:gap-4 max-sm:px-6 max-sm:pt-8 max-sm:pb-6">
          <div className="flex flex-col gap-1">
            <Heading
              slot="title"
              className="text-sm font-semibold text-primary wrap-anywhere max-sm:text-lg"
            >
              {title}
            </Heading>
            {description && (
              <Text slot="description" className="text-sm text-tertiary wrap-anywhere">
                {description}
              </Text>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-error-primary">
              {error}
            </p>
          )}
          <DialogActions>
            <DialogCancel isDisabled={pending} onPress={close}>
              {cancelLabel ?? m.controls_cancel()}
            </DialogCancel>
            <DialogAction
              autoFocus
              color={tone === "final" ? "primary" : "secondary-destructive"}
              isLoading={pending}
              showTextWhileLoading
              onPress={() => {
                if (pending) return;
                setError(null);
                void guard(async () => {
                  try {
                    await onConfirm();
                    setOpen(false);
                    focusFallbackOnceSettled();
                  } catch (cause) {
                    setError(typeof errorMessage === "string" ? errorMessage : errorMessage(cause));
                  }
                });
              }}
            >
              {pending && pendingLabel ? pendingLabel : confirmLabel}
            </DialogAction>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (pending || isDisabled) return;
        setError(null);
        setOpen(nextOpen);
      }}
    >
      {children}
      {phone ? (
        <ModalOverlay confirmation isDismissable={!pending}>
          <Modal className="w-full">{content}</Modal>
        </ModalOverlay>
      ) : (
        <Popover
          placement={placement}
          offset={6}
          className={cx(
            "w-72 max-w-[calc(100vw-1rem)] origin-(--trigger-anchor-point) rounded-3xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none will-change-transform",
            POPOVER_MOTION,
          )}
        >
          {content}
        </Popover>
      )}
    </DialogTrigger>
  );
}
