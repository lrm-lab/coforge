import type { ComponentType, ReactNode } from "react";
import { ArrowLeft, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function DetailsPaneHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header
      {...PANE_HEADER_ATTR}
      className={cn(PANE_HEADER_CLASS, "justify-between gap-2 px-4 md:px-6")}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          className="-ml-1.5 md:hidden"
          aria-label={m.conversation_details_close()}
          onClick={onClose}
        />
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">{title}</h2>
      </div>
      <ButtonUtility
        icon={XClose}
        size="sm"
        color="tertiary"
        className="-mr-1.5 hidden md:inline-flex"
        tooltip={m.conversation_details_close()}
        aria-label={m.conversation_details_close()}
        onClick={onClose}
      />
    </header>
  );
}

export function SectionEyebrow({
  icon: Icon,
  title,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-tertiary">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <h3>{title}</h3>
    </div>
  );
}

export function SettingsCard({
  children,
  divided = false,
  className,
}: {
  children: ReactNode;
  divided?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container/settings-card rounded-xl border border-secondary bg-primary",
        divided && "divide-y divide-secondary",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PreferenceRow({
  title,
  description,
  children,
  stackWhenNarrow = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  stackWhenNarrow?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex p-3.5",
        stackWhenNarrow
          ? "flex-col gap-2.5 @[19rem]/settings-card:flex-row @[19rem]/settings-card:items-center @[19rem]/settings-card:justify-between @[19rem]/settings-card:gap-3"
          : "flex-wrap items-center justify-between gap-x-3 gap-y-2",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{title}</p>
        {description && <p className="mt-0.5 text-sm text-tertiary">{description}</p>}
      </div>
      <div className={cn("shrink-0", stackWhenNarrow && "w-full @[19rem]/settings-card:w-auto")}>
        {children}
      </div>
    </div>
  );
}
