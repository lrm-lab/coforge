import type { ComponentType, ReactNode } from "react";
import { ArrowLeft, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function DetailsPaneHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-secondary px-4 md:px-6">
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
        "rounded-xl border border-secondary bg-primary",
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
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 p-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{title}</p>
        {description && <p className="mt-0.5 text-sm text-tertiary">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
