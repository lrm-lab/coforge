import { Cursor02 } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import type { CommentAnchor } from "./artifact-comment-inputs";
import { extractElementTag, hasInlineRefs, parseInlineRefs } from "./artifact-inline-refs";

export const CHIP_SURFACE_CLASS =
  "inline-flex max-w-44 items-center gap-1 rounded-md bg-brand-secondary px-1.5 py-0.5 align-baseline font-mono text-xs font-medium text-brand-secondary whitespace-nowrap select-all";

export function InlineElementChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span className={cn(CHIP_SURFACE_CLASS, className)}>
      <Cursor02
        aria-hidden="true"
        strokeWidth={1.5}
        className="size-2.5 shrink-0 text-fg-brand-primary"
      />
      <span className="truncate">{`<${tag}>`}</span>
    </span>
  );
}

export function InlineRefText({
  body,
  anchor,
  path,
}: {
  body: string;
  anchor?: CommentAnchor | null;
  path?: string | null;
}) {
  if (hasInlineRefs(body)) {
    const segments = parseInlineRefs(body);
    return (
      <>
        {segments.map((segment, index) =>
          segment.kind === "element" ? (
            <InlineElementChip
              key={`${index}:${segment.selector}`}
              tag={segment.tag}
              className="mx-0.5"
            />
          ) : (
            <span key={index} className="break-words">
              {segment.text}
            </span>
          ),
        )}
      </>
    );
  }
  const badge = fallbackBadge(anchor ?? null, path ?? null);
  return (
    <>
      {badge &&
        (badge.kind === "element" ? (
          <InlineElementChip tag={badge.tag} className="mr-1.5" />
        ) : (
          <span className="mr-1.5 inline-flex max-w-44 truncate rounded-md bg-brand-secondary px-1.5 py-0.5 align-baseline font-mono text-xs font-medium text-brand-secondary">
            {badge.label}
          </span>
        ))}
      {body && <span className="break-words">{body}</span>}
    </>
  );
}

function fallbackBadge(
  anchor: CommentAnchor | null,
  path: string | null,
): { kind: "element"; tag: string } | { kind: "other"; label: string } | null {
  if (anchor?.type === "element") {
    const selector = typeof anchor.data.selector === "string" ? anchor.data.selector : "";
    if (selector) {
      return {
        kind: "element",
        tag: extractElementTag(selector),
      };
    }
  }
  if (anchor?.type === "text") {
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (quote) {
      return {
        kind: "other",
        label: quote.length > 28 ? `“${quote.slice(0, 28)}…”` : `“${quote}”`,
      };
    }
  }
  if (anchor?.type === "lines") {
    const start = Number(anchor.data.start ?? anchor.data.from ?? 0);
    const end = Number(anchor.data.end ?? anchor.data.to ?? start);
    if (start > 0) {
      return { kind: "other", label: start === end ? `L${start}` : `L${start}–${end}` };
    }
  }
  if (anchor?.type === "page") {
    const label =
      typeof anchor.data.label === "string" && anchor.data.label
        ? anchor.data.label
        : typeof anchor.data.name === "string"
          ? anchor.data.name
          : "";
    if (label) return { kind: "other", label };
  }
  if (!anchor && path) return null;
  return null;
}
