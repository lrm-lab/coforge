import type { ReactNode } from "react";
import { Check } from "@untitledui/icons";

import { cn } from "#src/lib/utils";

export function Key({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "inline-grid h-4.5 min-w-4.5 place-items-center rounded-sm bg-primary px-1 font-body text-xs/4 text-secondary shadow-[inset_0_0_0_1px_var(--color-border-secondary),0_1px_0_var(--color-border-secondary)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Mark({ on, many, dim }: { on: boolean; many: boolean; dim?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-4.5 shrink-0 place-items-center text-white transition-[background-color,box-shadow] duration-100",
        many ? "rounded-[0.3125rem]" : "rounded-full",
        on
          ? dim
            ? "bg-fg-quaternary"
            : "bg-fg-primary"
          : dim
            ? "shadow-[inset_0_0_0_1.5px_var(--color-border-secondary)]"
            : "shadow-[inset_0_0_0_1.5px_var(--color-border-primary)]",
      )}
    >
      <Check
        className={cn(
          "size-3 transition-[opacity,scale] duration-150",
          on ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
    </span>
  );
}

export const OPTION_ROW =
  "flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm min-h-10 max-sm:min-h-12 max-sm:py-3";

export const OPTION_ROW_LIVE =
  "cursor-pointer border-secondary pointer-fine:hover:bg-secondary active:bg-secondary";
