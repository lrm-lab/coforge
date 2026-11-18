import type { ReactNode } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { cn } from "#src/lib/utils";

export function ArtifactSidePanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useHotkey("Escape", () => onClose());

  return (
    <aside
      aria-label={label}
      className={cn(
        "flex w-[21.25rem] shrink-0 flex-col border-l border-secondary bg-primary",
        "sm:@max-3xl/artifact:absolute sm:@max-3xl/artifact:inset-y-0 sm:@max-3xl/artifact:right-0 sm:@max-3xl/artifact:z-30 sm:@max-3xl/artifact:max-w-full sm:@max-3xl/artifact:shadow-xl",
        "max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:w-full max-sm:min-w-0 max-sm:flex-1 max-sm:border-l-0",
      )}
    >
      {children}
    </aside>
  );
}
