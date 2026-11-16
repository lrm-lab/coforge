import { m } from "#src/paraglide/messages";
import type { CommentAnchor } from "./artifact-comment-inputs";

function anchorDescription(anchor: CommentAnchor | null): { place?: string; quote?: string } {
  if (!anchor) return {};
  const { data } = anchor;
  if (anchor.type === "lines") {
    const start = Number(data.start);
    const end = Number(data.end);
    return {
      place: start === end ? m.av_cm_line({ line: start }) : m.av_cm_lines({ start, end }),
    };
  }
  if (anchor.type === "text" && typeof data.quote === "string") return { quote: data.quote };
  if (anchor.type === "element")
    return {
      quote:
        typeof data.quote === "string" && data.quote
          ? data.quote
          : typeof data.selector === "string"
            ? data.selector
            : undefined,
    };
  return {};
}

export function CommentAnchorLine({
  path,
  anchor,
}: {
  path: string | null;
  anchor: CommentAnchor | null;
}) {
  const { place, quote } = anchorDescription(anchor);
  if (path === null && !place && !quote) return null;
  return (
    <p className="min-w-0 text-xs text-tertiary [overflow-wrap:anywhere]">
      {path !== null && (
        <span className="font-medium text-secondary">{m.av_cm_in_file({ path })}</span>
      )}
      {place && <span>{path !== null ? ` · ${place}` : place}</span>}
      {quote && (
        <span className="line-clamp-2 block italic">{m.av_cm_anchor_quote({ quote })}</span>
      )}
    </p>
  );
}
