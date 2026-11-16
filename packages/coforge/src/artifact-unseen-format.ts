import { foldUntrustedLine, formatUtcTimestamp } from "@lrm/coforge-sdk/internal";
import {
  commentId,
  entry,
  name,
  type Actor,
  type CommentAnswer,
} from "#src/artifact-comment-format";
import { plural } from "#src/plural";

export type UnseenVersion = {
  number: number;
  publisher: { kind: "user" | "agent"; name: string };
  createdAt: string;
  note: string;
  label: string;
  changedPaths: string[];
  changedCount: number;
};

export type ArtifactUnseen = {
  firstRead: boolean;
  versionCount: number;
  versions: UnseenVersion[];
};

export type UnseenExcerptAnswer = {
  id: string;
  author: Actor;
  path: string | null;
  createdAt: string;
  excerpt: string;
};

export type UnseenCommentsAnswer = {
  count: number;
  comments: CommentAnswer[];
  excerpts: UnseenExcerptAnswer[];
  unread: number;
};

const excerptLine = (comment: UnseenExcerptAnswer) =>
  `- ${commentId(comment.id)} ${name(comment.author)}${comment.path === null ? "" : ` ${foldUntrustedLine(comment.path)}`}, ${formatUtcTimestamp(comment.createdAt)}: ${foldUntrustedLine(comment.excerpt)}`;

export function formatUnseenComments(
  artifact: string,
  unseen: UnseenCommentsAnswer | null | undefined,
): string[] {
  if (!unseen || unseen.count === 0) return [];
  const { count, comments, excerpts, unread } = unseen;
  const more = unread - excerpts.length;
  return [
    `${plural(count, "new comment")} from others${comments.length > 0 ? `, ${comments.length === count ? "all" : plural(comments.length, "comment")} shown in full (counted as read)` : ""}:`,
    ...comments.flatMap((comment) => entry(comment, "", true)),
    ...excerpts.map(excerptLine),
    ...(unread > 0
      ? [
          `${plural(unread, "comment")} not read yet${more > 0 ? ` (${more} not even excerpted)` : ""}: coforge artifact comments ${artifact}`,
        ]
      : []),
  ];
}

type Shown = {
  comments?: CommentAnswer[];
  excerpts?: UnseenExcerptAnswer[];
  versions?: UnseenVersion[];
};

export function formatUnseenChanges(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const raw = details?.unseen;
  if (typeof raw !== "string") return undefined;
  let shown: Shown;
  try {
    shown = JSON.parse(raw) as Shown;
  } catch {
    return undefined;
  }
  const comments = shown.comments ?? [];
  const excerpts = shown.excerpts ?? [];
  const versionCount = typeof details?.versionCount === "number" ? details.versionCount : 0;
  const skipped = typeof details?.skippedComments === "number" ? details.skippedComments : 0;
  return [
    "What changed (everything shown in full counts as seen):",
    ...comments.flatMap((comment) => entry(comment, "", true)),
    ...excerpts.map(excerptLine),
    ...(versionCount > 0
      ? formatUnseen({ firstRead: false, versionCount, versions: shown.versions ?? [] })
      : []),
    ...(skipped > 0
      ? [`${plural(skipped, "other comment")} on files this does not touch were passed over.`]
      : []),
  ].join("\n");
}

export function unseenRetry(artifact: string, details: Record<string, unknown> | undefined) {
  const unread = typeof details?.unread === "number" ? details.unread : 0;
  return unread > 0
    ? `${plural(unread, "comment")} above ${unread === 1 ? "is" : "are"} only excerpted: read ${unread === 1 ? "it" : "them"} in full first (coforge artifact comments ${artifact}), then run the same command again.`
    : "Run the same command again: what was shown above counts as seen.";
}

export function formatUnseen({
  firstRead,
  versionCount,
  versions: shown,
}: ArtifactUnseen): string[] {
  if (versionCount === 0)
    return [
      firstRead
        ? "Your first read of it: nothing from others to show."
        : "Nothing new since you last looked.",
    ];
  const earlier = versionCount - shown.length;
  return [
    firstRead
      ? `You haven't read it before: ${plural(versionCount, "version")} so far. The newest:`
      : `New since you last looked: ${plural(versionCount, "version")}`,
    ...shown.map(unseenLine),
    ...(earlier > 0 ? [`- … ${plural(earlier, "version")} earlier`] : []),
  ];
}

const CHANGED_SHOWN = 4;

function unseenLine(version: UnseenVersion): string {
  const said = foldUntrustedLine(version.note || version.label);
  const paths = version.changedPaths.map(foldUntrustedLine);
  const more = version.changedCount - CHANGED_SHOWN;
  const changed = paths.length
    ? ` (changed: ${paths.slice(0, CHANGED_SHOWN).join(", ")}${more > 0 ? `, +${more} more` : ""})`
    : "";
  return `- v${version.number} by ${foldUntrustedLine(version.publisher.name)}, ${formatUtcTimestamp(version.createdAt)}${said ? `: ${said}` : ""}${changed}`;
}
