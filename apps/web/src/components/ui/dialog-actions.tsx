import type { ReactNode } from "react";

import { Button, type Props as ButtonProps } from "#src/components/base/buttons/button";
import { useConfirmationSheet } from "#src/components/ui/modal";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cx } from "#src/utils/cx";

export function useDialogControlSize(): "sm" | "md" {
  return useMediaQuery("(pointer: coarse)", false) ? "md" : "sm";
}

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

type RowButtonProps<K extends keyof ButtonProps> = ButtonProps extends infer P
  ? P extends ButtonProps
    ? Omit<P, K>
    : never
  : never;

export function DialogCancel(props: RowButtonProps<"size" | "color">) {
  const size = useDialogControlSize();
  const color = useConfirmationSheet() ? "secondary" : "tertiary";
  return "href" in props ? (
    <Button {...props} size={size} color={color} />
  ) : (
    <Button {...props} size={size} color={color} />
  );
}

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
