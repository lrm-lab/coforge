import type { ReactNode } from "react";

import { Button, type Props as ButtonProps } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";

/** Every button a dialog shows, in its button row or beside a field: the height of the app's
 * inputs (40px). Raft sizes its dialog buttons to its own inputs the same way. */
export const DIALOG_BUTTON_SIZE = "md";

/**
 * A dialog's button row, as on Raft: right-aligned and 8px apart, with no rule above it; Cancel or
 * Close comes first as a borderless button, then the action. Its buttons share one height, so a row
 * never mixes sizes.
 */
export function DialogActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex flex-wrap items-center justify-end gap-2", className)}>{children}</div>
  );
}

/** A button's props without the ones the row sets, kept per variant so a link action (`href`)
 * stays a link. */
type RowButtonProps<K extends keyof ButtonProps> = ButtonProps extends infer P
  ? P extends ButtonProps
    ? Omit<P, K>
    : never
  : never;

/** The row's Cancel or Close: borderless, as Raft's ghost button. */
export function DialogCancel(props: RowButtonProps<"size" | "color">) {
  // Narrowed per variant: Button is overloaded for links and buttons, not for their union.
  return "href" in props ? (
    <Button {...props} size={DIALOG_BUTTON_SIZE} color="tertiary" />
  ) : (
    <Button {...props} size={DIALOG_BUTTON_SIZE} color="tertiary" />
  );
}

/** The row's action, primary unless the caller picks another colour. */
export function DialogAction({ color = "primary", ...props }: RowButtonProps<"size">) {
  return "href" in props ? (
    <Button {...props} size={DIALOG_BUTTON_SIZE} color={color} />
  ) : (
    <Button {...props} size={DIALOG_BUTTON_SIZE} color={color} />
  );
}
