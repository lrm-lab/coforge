import type { ComponentProps, ReactNode } from "react";
import { RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type EmptyStateSize = "page" | "card" | "row" | "menu";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  size?: EmptyStateSize;
  picture?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  live?: "polite";
  headingLevel?: 1 | 2 | 3;
}

export function EmptyState({
  size = "page",
  picture,
  title,
  description,
  primaryAction,
  secondaryAction,
  live,
  headingLevel,
  role,
  className,
  ...props
}: EmptyStateProps) {
  const liveProps =
    live === "polite" ? ({ "aria-live": "polite", "aria-atomic": true } as const) : {};
  const titleSemantics =
    headingLevel !== undefined ? ({ role: "heading", "aria-level": headingLevel } as const) : {};

  if (size === "menu") {
    return (
      <div
        data-slot="empty-state"
        data-size="menu"
        role={role}
        {...liveProps}
        className={cn("px-2.5 py-2 text-sm text-tertiary", className)}
        {...props}
      >
        {title}
      </div>
    );
  }

  if (size === "row") {
    return (
      <div
        data-slot="empty-state"
        data-size="row"
        role={role}
        {...liveProps}
        className={cn(
          "empty-state-enter flex min-h-10 items-center justify-between gap-3 px-3 py-2 text-sm text-quaternary",
          className,
        )}
        {...props}
      >
        <span className="min-w-0 break-keep [overflow-wrap:anywhere]">{title}</span>
        {(primaryAction || secondaryAction) && (
          <div className="flex shrink-0 items-center gap-2">
            {primaryAction}
            {secondaryAction}
          </div>
        )}
      </div>
    );
  }

  if (size === "card") {
    return (
      <div
        data-slot="empty-state"
        data-size="card"
        role={role}
        {...liveProps}
        className={cn(
          "empty-state-enter flex items-center gap-3 rounded-xl border border-secondary bg-primary px-3.5 py-3",
          className,
        )}
        {...props}
      >
        {picture && (
          <div aria-hidden="true" className="shrink-0">
            {picture}
          </div>
        )}
        <div
          {...titleSemantics}
          className="min-w-0 flex-1 text-sm font-medium break-keep text-primary [overflow-wrap:anywhere]"
        >
          {title}
        </div>
        {(primaryAction || secondaryAction) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {primaryAction}
            {secondaryAction}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-slot="empty-state"
      data-size="page"
      role={role}
      {...liveProps}
      className={cn(
        "empty-state-enter mx-auto flex w-full max-w-lg min-w-0 flex-1 flex-col items-center justify-center px-6 pt-8 pb-[12%] text-center text-balance",
        className,
      )}
      {...props}
    >
      {picture && (
        <div
          aria-hidden="true"
          className="mb-4 flex shrink-0 items-center justify-center [&_svg]:shrink-0"
        >
          {picture}
        </div>
      )}
      <div {...titleSemantics} className="text-md font-semibold text-primary">
        {title}
      </div>
      {description && (
        <p className="mt-1.5 max-w-sm text-center text-sm break-keep text-tertiary [overflow-wrap:anywhere]">
          {description}
        </p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function RetryButton({
  size = "page",
  isRetrying = false,
  label,
  onPress,
  className,
}: {
  size?: "page" | "card" | "row";
  isRetrying?: boolean;
  label?: string;
  onPress: () => void;
  className?: string;
}) {
  const color = size === "page" ? "secondary" : size === "card" ? "tertiary" : "link-gray";
  const buttonSize = size === "row" ? "xs" : "sm";
  return (
    <Button
      size={buttonSize}
      color={color}
      isDisabled={isRetrying}
      onPress={onPress}
      className={className}
      iconLeading={
        <RefreshCw01
          aria-hidden="true"
          className={cn(
            size === "row" ? "size-3.5" : "size-4",
            "shrink-0",
            isRetrying && "motion-safe:animate-spin",
          )}
        />
      }
    >
      {label ?? m.controls_retry()}
    </Button>
  );
}

function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "empty-state-enter mx-auto flex w-full max-w-lg min-w-0 flex-1 flex-col items-center justify-center p-6 text-center text-balance",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("mb-5 flex max-w-sm flex-col items-center gap-2", className)}
      {...props}
    />
  );
}

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: "default" | "icon" }) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      aria-hidden="true"
      className={cn(
        "relative mb-4 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "icon" &&
          "size-10 rounded-lg bg-primary text-primary ring-1 ring-secondary [&_svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("text-md font-semibold text-primary", className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn(
        "text-center text-sm break-keep text-tertiary [overflow-wrap:anywhere] [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-brand-secondary",
        className,
      )}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-3 text-sm text-balance",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
