import { Button as AriaButton } from "react-aria-components";
import { XClose } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { CommentAnchor } from "./artifact-comment-inputs";

export function formatAnchorTag(anchor: CommentAnchor | null, path?: string | null): string {
  if (anchor?.type === "element") {
    const label = typeof anchor.data.label === "string" ? anchor.data.label.trim() : "";
    if (label) return label;
    const selector = typeof anchor.data.selector === "string" ? anchor.data.selector.trim() : "";
    if (selector) {
      const last = selector.split(">").pop()?.trim() ?? selector;
      const clean = last.replace(/:nth-[a-z-]+\([^)]*\)/gi, "").trim();
      return clean.startsWith("<") ? clean : `<${clean}>`;
    }
    return path || "page";
  }
  if (anchor?.type === "text") {
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (!quote) return path || "page";
    return quote.length > 26 ? `“${quote.slice(0, 26)}…”` : `“${quote}”`;
  }
  if (anchor?.type === "lines") {
    return anchor.data.from === anchor.data.to
      ? `L${anchor.data.from}`
      : `L${anchor.data.from}–${anchor.data.to}`;
  }
  return path || "page";
}

export function AnchorChip({
  label,
  onRemove,
  className,
}: {
  label: string;
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-48 items-center gap-1 rounded-md bg-warning-secondary/75 px-1.5 py-0.5 font-mono text-xs font-medium text-warning-primary dark:bg-warning-solid/15",
        className,
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 12 12" className="size-2.5 shrink-0 fill-warning-solid">
        <path d="M1.5 1.5L10.5 5.2L6.3 6.5L4.8 10.5L1.5 1.5Z" />
      </svg>
      <span className="truncate">{label}</span>
      {onRemove && (
        <AriaButton
          aria-label={m.controls_cancel()}
          onPress={onRemove}
          className="ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-warning-primary/70 transition-colors hover:text-warning-primary"
        >
          <XClose className="size-2.5" />
        </AriaButton>
      )}
    </span>
  );
}
