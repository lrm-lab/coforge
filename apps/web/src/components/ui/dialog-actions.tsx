import type { ReactNode } from "react";

import { Button, type Props as ButtonProps } from "#src/components/base/buttons/button";
import { useConfirmationSheet } from "#src/components/ui/modal";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cx } from "#src/utils/cx";

/** A dialog's control size by pointer (task #224, Frank 11-06): `sm` (36px) on a precise pointer,
 * `md` (40px) on touch, where small targets are hard to hit. Buttons and the dialog's fields share
 * it — `DialogCancel`/`DialogAction` read it here, a bespoke `Button`/`Input`/`Select`/`TextArea`/
 * `ComboBox` inside a dialog takes `size={useDialogControlSize()}` — so a dialog never mixes sizes,
 * and Raft's rule holds: controls the same height, one size per device. Untitled UI's pairs are
 * `sm`/`sm` and `md`/`md`; there is no 32px input, so 36 is the smallest matched pair. */
export function useDialogControlSize(): "sm" | "md" {
  return useMediaQuery("(pointer: coarse)", false) ? "md" : "sm";
}

/**
 * A dialog's button row, as on Raft: right-aligned and 8px apart, with no rule above it; Cancel or
 * Close comes first as a borderless button, then the action. Its buttons share one height, so a row
 * never mixes sizes. A row whose only button closes the dialog (OK, Close) shows it outlined, as
 * its action, and a row keeps one filled button.
 */
export function DialogActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-dialog-actions
      className={cx("flex flex-wrap items-center justify-end gap-2", className)}
    >
      {children}
    </div>
  );
}

/** A button's props without the ones the row sets, kept per variant so a link action (`href`)
 * stays a link. */
type RowButtonProps<K extends keyof ButtonProps> = ButtonProps extends infer P
  ? P extends ButtonProps
    ? Omit<P, K>
    : never
  : never;

/** The row's Cancel or Close: borderless, as Raft's ghost button; outlined in a confirmation's
 * phone sheet, where it stacks full width under the action and must read as a button too. */
export function DialogCancel(props: RowButtonProps<"size" | "color">) {
  const size = useDialogControlSize();
  const color = useConfirmationSheet() ? "secondary" : "tertiary";
  // Narrowed per variant: Button is overloaded for links and buttons, not for their union.
  return "href" in props ? (
    <Button {...props} size={size} color={color} />
  ) : (
    <Button {...props} size={size} color={color} />
  );
}

/** The row's action, primary unless the caller picks another colour. In a confirmation's phone
 * sheet a red action is filled, the one thing to press at the bottom of the screen, unless
 * `outlinedInSheet` keeps it outlined beside another filled action (a row keeps one). */
export function DialogAction({
  color: chosen = "primary",
  outlinedInSheet = false,
  ...props
}: RowButtonProps<"size"> & { outlinedInSheet?: boolean }) {
  const size = useDialogControlSize();
  const sheet = useConfirmationSheet();
  const color =
    sheet && !outlinedInSheet && chosen === "secondary-destructive"
      ? "primary-destructive"
      : chosen;
  return "href" in props ? (
    <Button {...props} size={size} color={color} />
  ) : (
    <Button {...props} size={size} color={color} />
  );
}
