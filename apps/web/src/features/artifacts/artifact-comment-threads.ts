import type { ArtifactCommentView } from "./artifact-comment-queries";

export type CommentThread = { root: ArtifactCommentView; replies: ArtifactCommentView[] };

export type CommentGroups = {
  whole: CommentThread[];
  files: { path: string; threads: CommentThread[] }[];
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
  const groups: CommentGroups = { whole: [], files: [], resolved: [] };
  for (const thread of threads.values()) {
    if (thread.replies.every((reply) => "deleted" in reply) && "deleted" in thread.root) continue;
    if (isResolved(thread)) groups.resolved.push(thread);
    else if (thread.root.path === null) groups.whole.push(thread);
    else {
      const path = thread.root.path;
      const file = groups.files.find((entry) => entry.path === path);
      if (file) file.threads.push(thread);
      else groups.files.push({ path, threads: [thread] });
    }
  }
  return groups;
}

export function commentsCap(total: number): string {
  return total > 999 ? "999+" : String(total);
}
