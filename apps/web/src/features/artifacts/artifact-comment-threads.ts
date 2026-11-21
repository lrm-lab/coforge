import type { ArtifactCommentView } from "./artifact-comment-queries";
import type { ThreadPlaces } from "./artifact-commenting";

export type CommentThread = { root: ArtifactCommentView; replies: ArtifactCommentView[] };

export type CommentSortOrder = "page" | "updated";

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

export type VersionSection = {
  version: number;
  whole: CommentThread[];
  anchored: CommentThread[];
};

export function versionSections(groups: CommentGroups, shownVersion: number): VersionSection[] {
  const sections = new Map<number, VersionSection>();
  const sectionOf = (version: number) => {
    const held = sections.get(version);
    if (held) return held;
    const made: VersionSection = { version, whole: [], anchored: [] };
    sections.set(version, made);
    return made;
  };
  for (const thread of groups.whole) sectionOf(thread.root.version).whole.push(thread);
  for (const thread of groups.anchored) sectionOf(thread.root.version).anchored.push(thread);
  return [...sections.values()].sort(
    (left, right) =>
      Number(right.version === shownVersion) - Number(left.version === shownVersion) ||
      right.version - left.version,
  );
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

export function findThreadForComment(
  groups: CommentGroups,
  commentId: string,
): { thread: CommentThread; resolved: boolean } | null {
  const matches = (thread: CommentThread) =>
    thread.root.id === commentId || thread.replies.some((reply) => reply.id === commentId);
  for (const thread of groups.resolved) if (matches(thread)) return { thread, resolved: true };
  for (const thread of groups.whole) if (matches(thread)) return { thread, resolved: false };
  for (const thread of groups.anchored) if (matches(thread)) return { thread, resolved: false };
  return null;
}

export const canSaveCommentEdit = ({
  body,
  hasImages,
  tooLong,
  hasMentionError,
  saving,
}: {
  body: string;
  hasImages: boolean;
  tooLong: boolean;
  hasMentionError: boolean;
  saving: boolean;
}) => (body.trim() !== "" || hasImages) && !tooLong && !hasMentionError && !saving;

export function commentsCap(total: number): string {
  return total > 999 ? "999+" : String(total);
}

function commentTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function threadUpdatedAt(thread: CommentThread): number {
  let latest = commentTimestamp(thread.root.createdAt);
  if (!("deleted" in thread.root)) {
    latest = Math.max(latest, commentTimestamp(thread.root.editedAt));
  }
  for (const reply of thread.replies) {
    latest = Math.max(latest, commentTimestamp(reply.createdAt));
    if (!("deleted" in reply)) {
      latest = Math.max(latest, commentTimestamp(reply.editedAt));
    }
  }
  return latest;
}

export function sortThreadsByUpdated(threads: readonly CommentThread[]): CommentThread[] {
  return [...threads].sort(
    (left, right) =>
      threadUpdatedAt(right) - threadUpdatedAt(left) ||
      commentTimestamp(right.root.createdAt) - commentTimestamp(left.root.createdAt) ||
      left.root.id.localeCompare(right.root.id),
  );
}

function anchorSearchText(comment: Exclude<ArtifactCommentView, { deleted: true }>): string {
  if (!comment.anchor) return "";
  const { data } = comment.anchor;
  const parts: string[] = [];
  for (const key of ["quote", "label", "name", "selector"] as const) {
    const value = data[key];
    if (typeof value === "string" && value) parts.push(value);
  }
  return parts.join(" ");
}

export function matchesCommentSearch(thread: CommentThread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  for (const comment of [thread.root, ...thread.replies]) {
    if ("deleted" in comment) continue;
    if (comment.body.toLowerCase().includes(needle)) return true;
    if (comment.author.name.toLowerCase().includes(needle)) return true;
    if (comment.path && comment.path.toLowerCase().includes(needle)) return true;
    if (anchorSearchText(comment).toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function filterCommentGroups(groups: CommentGroups, query: string): CommentGroups {
  if (!query.trim()) return groups;
  return {
    whole: groups.whole.filter((thread) => matchesCommentSearch(thread, query)),
    anchored: groups.anchored.filter((thread) => matchesCommentSearch(thread, query)),
    resolved: groups.resolved.filter((thread) => matchesCommentSearch(thread, query)),
  };
}
