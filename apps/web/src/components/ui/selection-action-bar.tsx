import type { ReactNode } from "react";
import { XClose } from "@untitledui/icons";
import { Separator, Toolbar } from "react-aria-components";

import { Button, type ButtonProps } from "#src/components/base/buttons/button";
import {
  ButtonUtility,
  type ButtonProps as ButtonUtilityProps,
} from "#src/components/base/buttons/button-utility";
import { cx } from "#src/utils/cx";

const COARSE_TOUCH_TARGET_CLASS =
  "any-pointer-coarse:after:absolute any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:size-full any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:min-w-11 any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2";

export function SelectionActionBar({
  label,
  countLabel,
  clearLabel,
  onClear,
  children,
  className,
}: {
  label: string;
  countLabel: ReactNode;
  clearLabel: string;
  onClear: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex justify-center px-4 pt-2 pb-[max(0.75rem,var(--spacing-safe-bottom))]">
      <Toolbar
        aria-label={label}
        orientation="horizontal"
        data-selection-bar=""
        className={cx(
          "selection-bar-enter flex max-w-full min-w-0 items-center gap-1 rounded-full bg-selection-bar-bg py-1.5 pr-1.5 pl-3.5 text-primary shadow-(--selection-bar-shadow) ring-1 ring-selection-bar-ring ring-inset",
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <span
            aria-live="polite"
            aria-atomic="true"
            className="min-w-0 truncate text-sm font-medium whitespace-nowrap text-primary tabular-nums"
          >
            {countLabel}
          </span>
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={XClose}
            tooltip={clearLabel}
            onClick={onClear}
            className="shrink-0 rounded-full"
          />
        </div>
        <Separator
          orientation="vertical"
          className="mx-1 h-4 w-px shrink-0 bg-selection-bar-divider"
        />
        <div className="flex min-w-0 items-center gap-1">{children}</div>
      </Toolbar>
    </div>
  );
}

export function SelectionActionPrimaryButton({
  className,
  ...props
}: Omit<ButtonProps, "color" | "size">) {
  return (
    <Button
      size="xs"
      color="tertiary"
      {...props}
      className={cx(
        "h-8 shrink-0 rounded-full bg-selection-bar-primary px-3.5 text-sm font-semibold text-selection-bar-primary-fg hover:bg-selection-bar-primary_hover hover:text-selection-bar-primary-fg *:data-icon:text-current hover:*:data-icon:text-current",
        COARSE_TOUCH_TARGET_CLASS,
        className,
      )}
    />
  );
}

export function SelectionActionButton({
  className,
  ...props
}: Omit<ButtonProps, "color" | "size">) {
  return (
    <Button
      size="xs"
      color="tertiary"
      {...props}
      className={cx(
        "h-8 shrink-0 rounded-full px-3 text-sm font-medium text-secondary hover:bg-primary_hover hover:text-primary *:data-icon:text-current hover:*:data-icon:text-current",
        COARSE_TOUCH_TARGET_CLASS,
        className,
      )}
    />
  );
}

export function SelectionActionIconButton({
  className,
  ...props
}: Omit<ButtonUtilityProps, "color" | "size">) {
  return (
    <ButtonUtility
      size="sm"
      color="tertiary"
      {...props}
      className={cx("size-8 shrink-0 rounded-full p-0", className)}
    />
  );
}
