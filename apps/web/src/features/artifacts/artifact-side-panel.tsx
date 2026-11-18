import { useRef, useState, type PointerEvent, type ReactNode, useEffect } from "react";
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
        "max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:w-full max-sm:min-w-0 max-sm:flex-1 max-sm:border-l-0",
      )}
    >
      {children}
    </aside>
  );
}
