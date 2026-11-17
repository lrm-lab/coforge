import { Button as AriaButton } from "react-aria-components";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ELEMENT_LABEL_MAX } from "./artifact-page-annotations";
import { clip } from "./artifact-text-anchor";
import type { CommentAnchor } from "./artifact-comment-inputs";
import { anchorStatus, useArtifactCommenting, useCommentPlaces } from "./artifact-commenting";

export type AnchorDescription = { place?: string; excerpt?: string };

const quoted = (quote: unknown): AnchorDescription =>
  typeof quote === "string" && quote ? { excerpt: m.av_cm_anchor_quote({ quote }) } : {};

export function describeAnchor(anchor: CommentAnchor | null): AnchorDescription {
  if (!anchor) return {};
  const { data } = anchor;
  if (anchor.type === "lines") {
    const start = Number(data.start);
    const end = Number(data.end);
    return {
      place: start === end ? m.av_cm_line({ line: start }) : m.av_cm_lines({ start, end }),
    };
  }
  if (anchor.type === "page") {
    const label = typeof data.label === "string" && data.label ? data.label : data.name;
    return {
      ...(typeof label === "string" ? { place: label } : {}),
      ...(typeof data.quote === "string" && data.quote
        ? { excerpt: m.av_cm_page_quote({ quote: data.quote }) }
        : {}),
    };
  }
  if (anchor.type === "text") return quoted(data.quote);
  if (anchor.type === "element")
    return quoted(
      typeof data.quote === "string" && data.quote
        ? data.quote
        : typeof data.selector === "string"
          ? clip(data.selector, ELEMENT_LABEL_MAX)
          : undefined,
    );
  return {};
}

export function CommentAnchorLine({
  commentId,
  path,
  anchor,
}: {
  commentId: string;
  path: string | null;
  anchor: CommentAnchor | null;
}) {
  const commenting = useArtifactCommenting();
  const places = useCommentPlaces();
  if (path === null) return null;
  const { place, excerpt } = describeAnchor(anchor);
  const status = anchorStatus(commenting, places, commentId, path);
  return (
    <AriaButton
      data-comment-anchor=""
      data-anchor-status={status}
      isDisabled={status === "missing"}
      className={cn(
        "min-w-0 text-left text-xs text-tertiary [overflow-wrap:anywhere]",
        "rounded-sm outline-focus-ring focus-visible:outline-2",
        status !== "missing" && "cursor-pointer hover:text-secondary",
      )}
      onPress={() => commenting.revealThread({ path, anchor })}
    >
      <span>
        <span className="font-medium text-secondary">{m.av_cm_in_file({ path })}</span>
        {place && ` · ${place}`}
        {status === "changed" && (
          <span className="text-warning-primary"> · {m.av_cm_anchor_changed()}</span>
        )}
        {status === "missing" && (
          <span className="text-warning-primary"> · {m.av_cm_anchor_missing()}</span>
        )}
      </span>
      {excerpt && <span className="line-clamp-2 block">{excerpt}</span>}
    </AriaButton>
  );
}
