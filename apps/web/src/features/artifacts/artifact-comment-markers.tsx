import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { m } from "#src/paraglide/messages";
import { CommentAuthorAvatar } from "./artifact-comment-avatar";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import type { CommentThread } from "./artifact-comment-threads";

export type CommentMarker =
  | { kind: "thread"; thread: CommentThread; top: number }
  | { kind: "draft"; draft: CommentDraftView; top: number };

export const MARKER_SIZE = 28;
export const MARKER_GAP = 4;

export function stackMarkers(placed: readonly CommentMarker[]): CommentMarker[] {
  let floor = Number.NEGATIVE_INFINITY;
  return [...placed]
    .sort((left, right) => left.top - right.top)
    .map((marker) => {
      const stacked = Math.max(marker.top, floor);
      floor = stacked + MARKER_SIZE + MARKER_GAP;
      return { ...marker, top: stacked };
    });
}

export function ArtifactCommentMarkers({
  markers,
  left,
  onOpen,
  onOpenDraft,
}: {
  markers: readonly CommentMarker[];
  left: number;
  onOpen: (thread: CommentThread) => void;
  onOpenDraft: (draft: CommentDraftView) => void;
}) {
  if (markers.length === 0) return null;
  return (
    <ul aria-label={m.av_cm_margin_label()} data-comment-markers="">
      {markers.map((marker) => {
        const { top } = marker;
        if (marker.kind === "draft")
          return (
            <li key={marker.draft.id} style={{ top, left }} className="absolute z-10">
              <Tooltip title={m.av_dr_marker()}>
                <TooltipTrigger
                  aria-label={m.av_dr_marker()}
                  data-draft-marker={marker.draft.id}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-brand bg-primary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                  onPress={() => onOpenDraft(marker.draft)}
                />
              </Tooltip>
            </li>
          );
        const { thread } = marker;
        const { root } = thread;
        if ("deleted" in root) return null;
        const replies = thread.replies.filter((reply) => !("deleted" in reply)).length;
        const label =
          replies > 0
            ? `${m.av_cm_marker({ name: root.author.name })}, ${m.av_cm_marker_replies({ count: replies })}`
            : m.av_cm_marker({ name: root.author.name });
        return (
          <li key={root.id} style={{ top, left }} className="absolute z-10">
            <Tooltip title={label}>
              <TooltipTrigger
                aria-label={label}
                data-comment-marker={root.id}
                className="flex cursor-pointer items-center gap-1 rounded-full bg-primary p-0.5 pr-1 shadow-xs ring-1 ring-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                onPress={() => onOpen(thread)}
              >
                <CommentAuthorAvatar comment={root} size="xs" />
                {replies > 0 && (
                  <span className="text-xs font-medium text-tertiary tabular-nums">{replies}</span>
                )}
              </TooltipTrigger>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
