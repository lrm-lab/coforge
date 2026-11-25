import type { FC, ReactNode } from "react";
import { ChevronRight } from "@untitledui/icons";
import {
  Breadcrumb as AriaBreadcrumb,
  Breadcrumbs as AriaBreadcrumbs,
  Button as AriaButton,
} from "react-aria-components";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type BreadcrumbItem = {
  label: string;
  onPress?: () => void;
  link?: (className: string) => ReactNode;
};

const CRUMB_INTERACTIVE_CLASS =
  "inline-flex max-w-[9rem] min-w-0 cursor-pointer items-center truncate rounded-sm text-sm font-medium text-tertiary outline-focus-ring transition-colors duration-100 ease-out hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 any-pointer-coarse:min-h-11 sm:max-w-[13rem]";

const CRUMB_STATIC_CLASS =
  "inline-flex max-w-[9rem] min-w-0 items-center truncate text-sm font-medium text-tertiary sm:max-w-[13rem]";

function Separator() {
  return (
    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-quaternary rtl:rotate-180" />
  );
}

function CrumbControl({ item }: { item: BreadcrumbItem }) {
  if (item.link) return item.link(CRUMB_INTERACTIVE_CLASS);
  if (item.onPress) {
    return (
      <AriaButton onPress={item.onPress} className={CRUMB_INTERACTIVE_CLASS}>
        <span className="truncate">{item.label}</span>
      </AriaButton>
    );
  }
  return <span className={CRUMB_STATIC_CLASS}>{item.label}</span>;
}

export function PageBreadcrumbs({
  items,
  current,
  currentIcon: CurrentIcon,
  headingClassName,
  ariaLabel,
  className,
}: {
  items: readonly BreadcrumbItem[];
  current: string;
  currentIcon?: FC<{ className?: string }>;
  headingClassName?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const collapsedOnMobile = items.length > 1;
  return (
    <nav aria-label={ariaLabel ?? m.settings_breadcrumb()} className={cn("min-w-0", className)}>
      <AriaBreadcrumbs className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        {collapsedOnMobile && (
          <AriaBreadcrumb className="inline-flex shrink-0 items-center gap-1 sm:hidden">
            <span aria-hidden="true" className="text-sm text-quaternary">
              …
            </span>
            <Separator />
          </AriaBreadcrumb>
        )}
        {items.map((item, index) => {
          const isImmediateParent = index === items.length - 1;
          return (
            <AriaBreadcrumb
              key={`${item.label}-${index}`}
              className={cn(
                "min-w-0 shrink items-center gap-1",
                isImmediateParent ? "inline-flex" : "hidden sm:inline-flex",
              )}
            >
              <CrumbControl item={item} />
              <Separator />
            </AriaBreadcrumb>
          );
        })}
        <AriaBreadcrumb className="inline-flex min-w-0 items-center gap-1.5">
          {CurrentIcon && (
            <CurrentIcon aria-hidden="true" className="size-4 shrink-0 text-fg-secondary" />
          )}
          <h1
            aria-current="page"
            className={cn("truncate text-lg font-semibold text-primary", headingClassName)}
          >
            {current}
          </h1>
        </AriaBreadcrumb>
      </AriaBreadcrumbs>
    </nav>
  );
}
