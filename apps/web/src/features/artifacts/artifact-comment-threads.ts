import type { ArtifactCommentView } from "./artifact-comment-queries";
import type { ThreadPlaces } from "./artifact-commenting";

export type CommentThread = { root: ArtifactCommentView; replies: ArtifactCommentView[] };

export type CommentGroups = {
  whole: CommentThread[];
  anchored: CommentThread[];
  resolved: CommentThread[];
};

export const isResolved = (thread: CommentThread) =>
  !("deleted" in thread.root) && thread.root.resolvedAt !== null;

export function groupThreads(comments: readonly ArtifactCommentView[]): CommentGroups {
  const threads = new Map<string, CommentThread>();
  for (const comment of comments)
    if (comment.replyTo === null) threads.set(comment.id, { root: comment, replies: [] });
  for (const comment of comments)
    if (comment.replyTo !== null) threads.get(comment.replyTo)?.replies.push(comment);
  const groups: CommentGroups = { whole: [], anchored: [], resolved: [] };
  for (const thread of threads.values()) {
    if (thread.replies.every((reply) => "deleted" in reply) && "deleted" in thread.root) continue;
    if (isResolved(thread)) groups.resolved.push(thread);
    else if (thread.root.path === null) groups.whole.push(thread);
    else groups.anchored.push(thread);
  }
  return groups;
}

const UNPLACED = Number.MAX_SAFE_INTEGER;

function threadPosition({ root }: CommentThread, places: ThreadPlaces | undefined): number {
  if ("deleted" in root || !root.anchor) return -1;
  const place = places?.get(root.id);
  if (place?.status === "found") return place.location.order;
  const { anchor } = root;
  if (anchor.type === "lines") return Number(anchor.data.start) || 0;
  return anchor.type === "file" ? -1 : UNPLACED;
}

export function orderAnchored(
  threads: readonly CommentThread[],
  fileOrder: readonly string[],
  places: ThreadPlaces | undefined,
): CommentThread[] {
  const rank = (path: string | null) => {
    const at = path === null ? -1 : fileOrder.indexOf(path);
    return at === -1 ? fileOrder.length : at;
  };
  return threads
    .map((thread) => ({
      thread,
      rank: rank(thread.root.path),
      position: threadPosition(thread, places),
    }))
    .sort((left, right) => left.rank - right.rank || left.position - right.position)
    .map(({ thread }) => thread);
}

export function commentsCap(total: number): string {
  return total > 999 ? "999+" : String(total);
}
