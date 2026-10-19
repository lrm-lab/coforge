import { isValidElement, type FC, type ReactNode } from "react";
import { AlertCircle, CheckCircle, InfoCircle, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { cn } from "#src/lib/utils";

export type AlertColor = "default" | "gray" | "brand" | "error" | "warning" | "success";

const ALERT_COLORS: Record<
  AlertColor,
  {
    container: string;
    icon: FC<{ className?: string }>;
    featured: "gray" | "brand" | "error" | "warning" | "success";
  }
> = {
  default: { container: "border-secondary bg-primary", icon: InfoCircle, featured: "gray" },
  gray: { container: "border-secondary bg-secondary", icon: InfoCircle, featured: "gray" },
  brand: {
    container: "border-secondary bg-brand-primary_alt",
    icon: InfoCircle,
    featured: "brand",
  },
  error: {
    container: "border-error_subtle bg-error-primary",
    icon: AlertCircle,
    featured: "error",
  },
  warning: {
    container: "border-secondary bg-warning-primary",
    icon: AlertCircle,
    featured: "warning",
  },
  success: {
    container: "border-secondary bg-success-primary",
    icon: CheckCircle,
    featured: "success",
  },
};

/**
 * An inline alert: a featured icon, a title and description, and the actions that answer it, inside
 * the area it is about (§13). Untitled UI's own Alert is PRO-only, so this composes the official
 * FeaturedIcon and ButtonUtility with semantic tokens; its props follow Untitled's documented Alert
 * so it can be swapped for that one.
 *
 * `icon` replaces the color's default: a component is drawn in the color's featured icon, a node
 * (for example a FeaturedIcon of another color, or a spinning icon) stands in for it whole. Below
 * 28rem of its own width the actions drop under the text.
 */
export function Alert({
  color = "default",
  title,
  description,
  icon,
  actions,
  onClose,
  dismissLabel,
  className,
}: {
  color?: AlertColor;
  title?: ReactNode;
  description?: ReactNode;
  icon?: FC<{ className?: string }> | ReactNode;
  actions?: ReactNode;
  /** Shows a close button; `dismissLabel` is its accessible name. */
  onClose?: () => void;
  dismissLabel?: string;
  className?: string;
}) {
  const colors = ALERT_COLORS[color];
  const urgent = color === "error" || color === "warning";
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={cn("@container rounded-xl border px-4 py-3.5", colors.container, className)}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3 @max-md:flex-col">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {isValidElement(icon) ? (
              <span className="flex shrink-0">{icon}</span>
            ) : (
              <FeaturedIcon
                color={colors.featured}
                theme="light"
                size="sm"
                icon={(icon as FC<{ className?: string }> | undefined) ?? colors.icon}
              />
            )}
            <div className="min-w-0 flex-1 text-sm">
              {title && <div className="font-semibold text-primary">{title}</div>}
              {description && (
                // A description with no title is the message itself, so it reads at body weight.
                <div className={title ? "mt-1 text-tertiary" : "text-secondary"}>{description}</div>
              )}
            </div>
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 @max-md:pl-11">
              {actions}
            </div>
          )}
        </div>
        {onClose && (
          <ButtonUtility
            icon={XClose}
            size="xs"
            color="tertiary"
            className="-mt-1 -mr-1 shrink-0"
            aria-label={dismissLabel}
            onClick={onClose}
          />
        )}
      </div>
    </div>
  );
}
