import { useState, type ReactNode } from "react";
import { Heading, Popover, Text, type PopoverProps } from "react-aria-components";

import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, DialogTrigger } from "#src/components/ui/modal";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

/** How long the popover takes to leave (`POPOVER_MOTION`), plus a margin, before focus is judged. */
const POPOVER_EXIT_SETTLE_MS = 200;

/** The second check for an irreversible change to one item the user owns, opened by the button
 * that asks for it (the child, a React Aria pressable) and anchored to it; a refusal stays in the
 * popover. Affecting others, a bulk change, or a decision to make first use `ConfirmDialog`. */
export function Popconfirm({
  title,
  description,
  confirmLabel,
  pendingLabel,
  errorMessage,
  onConfirm,
  placement = "bottom",
  isDisabled = false,
  fallbackFocus,
  children,
}: {
  /** The question ("Delete this template?"). */
  title: string;
  /** What cannot be undone, in one line. */
  description?: string;
  confirmLabel: string;
  /** What the confirm button says while the change runs ("Deleting…"); without it, `confirmLabel`. */
  pendingLabel?: string;
  /** What a refusal says: one text, or one chosen by what was thrown. */
  errorMessage: string | ((cause: unknown) => string);
  /** Performs the change; throws when it is refused. The popover closes when it succeeds. */
  onConfirm: () => Promise<void>;
  placement?: PopoverProps["placement"];
  /** The change does not apply now: the child stays the same element, with its own `onPress`, but
   * pressing it never opens the popover. One trigger across both states keeps its keyboard focus. */
  isDisabled?: boolean;
  /** Where focus goes after a confirm that left the trigger out of the document (a deleted row, a
   * button that gave way to a status): React Aria returns it to the trigger, and drops it on the
   * page when the trigger is gone. Not asked while focus is anywhere else. */
  fallbackFocus?: () => HTMLElement | null | undefined;
  /** The trigger button. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, guard] = useSubmitGuard();
  // A popover that is open when the change stops applying closes with it, and must not come back
  // when it applies again.
  if (isDisabled && open) setOpen(false);

  function focusFallbackOnceSettled() {
    if (!fallbackFocus) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      fallbackFocus()?.focus();
    }, POPOVER_EXIT_SETTLE_MS);
  }

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (pending || isDisabled) return;
        // Each opening starts clean: a refusal must not greet the next one.
        setError(null);
        setOpen(nextOpen);
      }}
    >
      {children}
      <Popover
        placement={placement}
        offset={6}
        className={cx(
          "w-72 max-w-[calc(100vw-1rem)] origin-(--trigger-anchor-point) rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none will-change-transform",
          POPOVER_MOTION,
        )}
      >
        <Dialog className="outline-none">
          {({ close }) => (
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-col gap-1">
                <Heading slot="title" className="text-sm font-semibold text-primary wrap-anywhere">
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
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  color="primary-destructive"
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
                        setError(
                          typeof errorMessage === "string" ? errorMessage : errorMessage(cause),
                        );
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
      </Popover>
    </DialogTrigger>
  );
}
