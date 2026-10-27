import type { ReactNode } from "react";

import { Button, type ButtonProps } from "#src/components/base/buttons/button";
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

/** The row's Cancel or Close: borderless, as Raft's ghost button. */
export function DialogCancel(props: Omit<ButtonProps, "size" | "color">) {
  return <Button {...props} size={DIALOG_BUTTON_SIZE} color="tertiary" />;
}

/** The row's action, primary unless the caller picks another colour. */
export function DialogAction({ color = "primary", ...props }: Omit<ButtonProps, "size">) {
  return <Button {...props} size={DIALOG_BUTTON_SIZE} color={color} />;
}
