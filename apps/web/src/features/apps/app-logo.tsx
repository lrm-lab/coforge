import { cn } from "#src/lib/utils";
import { appMonogram } from "./app-list";

/** An app's logo: its monogram on a neutral tile (apps have no uploaded logo yet). */
export function AppLogo({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-tertiary font-semibold text-secondary ring-1 ring-secondary ring-inset",
        size === "sm" ? "size-8 text-xs" : "size-10 text-sm",
      )}
    >
      {appMonogram(name)}
    </span>
  );
}
