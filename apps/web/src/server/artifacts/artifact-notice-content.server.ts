import type { ArtifactNoticeContent, NoticeLine } from "./artifact-notice-port.server";

export type NoticeReason =
  | "mentioned"
  | "subscribed"
  | "your_file_changed"
  | "your_comment_resolved";

export type NoticeActorKind = "agent" | "person";

export type NoticeEvent =
  | {
      kind: "comment";
      by: string;
      byKind: NoticeActorKind;
      comment: { id: string; path: string | null; version: number; body: string };
    }
  | {
      kind: "review";
      by: string;
      byKind: NoticeActorKind;
      review: { id: string; version: number; body: string | null };
      comments: readonly { path: string | null; body: string }[];
    }
  | {
      kind: "resolve";
      by: string;
      byKind: NoticeActorKind;
      thread: { id: string; path: string | null };
      note: string | undefined;
    }
  | {
      kind: "version";
      by: string;
      byKind: NoticeActorKind;
      number: number;
      note: string;
      yourFiles: readonly string[];
      renamed: { from: string; to: string } | null;
    }
  | { kind: "rename"; by: string; byKind: NoticeActorKind; from: string; to: string };

const EXCERPT_CHARS = 200;
const COMMENTS_SHOWN = 3;
const FILES_SHOWN = 5;

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= EXCERPT_CHARS ? flat : `${chars.slice(0, EXCERPT_CHARS - 1).join("")}…`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const quote = (label: string, value: string): NoticeLine => ({
  label,
  value: excerptOf(value),
  untrusted: true,
});
const where = (path: string | null): NoticeLine[] =>
  path === null ? [] : [{ label: "File", value: path, untrusted: true }];

const WHAT: Record<NoticeEvent["kind"], string> = {
  comment: "a comment",
  review: "a review",
  resolve: "a resolve note",
  version: "a new version",
  rename: "a new title",
};

const DID: Record<NoticeEvent["kind"], string> = {
  comment: "commented on",
  review: "reviewed",
  resolve: "resolved a thread of",
  version: "renamed",
  rename: "renamed",
};

function headline(reason: NoticeReason, event: NoticeEvent): string {
  const actor = event.byKind === "agent" ? "Another Agent" : "Someone";
  switch (reason) {
    case "mentioned":
      return `You were mentioned in ${WHAT[event.kind]} on an artifact.`;
    case "subscribed":
      return `${actor} ${DID[event.kind]} an artifact you follow.`;
    case "your_file_changed":
      return `${actor} changed a file you last changed.`;
    case "your_comment_resolved":
      return `${actor} resolved a thread you started.`;
  }
}

function details(event: NoticeEvent): NoticeLine[] {
  switch (event.kind) {
    case "comment":
      return [
        { label: "Comment", value: `c_${event.comment.id} on version ${event.comment.version}` },
        ...where(event.comment.path),
        quote("Text", event.comment.body),
      ];
    case "review": {
      const files = new Set(event.comments.flatMap((comment) => comment.path ?? []));
      return [
        {
          label: "Review",
          value: `${event.review.id} (${plural(event.comments.length, "comment")} on ${plural(files.size, "file")}, version ${event.review.version})`,
        },
        ...(event.review.body ? [quote("Summary", event.review.body)] : []),
        ...event.comments
          .slice(0, COMMENTS_SHOWN)
          .map((comment) =>
            quote(comment.path === null ? "Comment" : `Comment on ${comment.path}`, comment.body),
          ),
        ...(event.comments.length > COMMENTS_SHOWN
          ? [{ label: "More", value: `${event.comments.length - COMMENTS_SHOWN} further comments` }]
          : []),
      ];
    }
    case "resolve":
      return [
        { label: "Thread", value: `c_${event.thread.id}` },
        ...where(event.thread.path),
        ...(event.note ? [quote("Note", event.note)] : []),
      ];
    case "version":
      return [
        { label: "Version", value: String(event.number) },
        ...(event.note ? [quote("Note", event.note)] : []),
        ...(event.yourFiles.length
          ? [
              {
                label: "Your files changed",
                value: [
                  ...event.yourFiles.slice(0, FILES_SHOWN),
                  ...(event.yourFiles.length > FILES_SHOWN
                    ? [`and ${event.yourFiles.length - FILES_SHOWN} more`]
                    : []),
                ].join(", "),
                untrusted: true as const,
              },
            ]
          : []),
        ...(event.renamed
          ? [
              { label: "Old title", value: event.renamed.from, untrusted: true as const },
              { label: "New title", value: event.renamed.to, untrusted: true as const },
            ]
          : []),
      ];
    case "rename":
      return [
        { label: "Old title", value: event.from, untrusted: true },
        { label: "New title", value: event.to, untrusted: true },
      ];
  }
}

export function noticeContent(
  artifact: { id: string; title: string; name: string },
  reason: NoticeReason,
  event: NoticeEvent,
): ArtifactNoticeContent {
  return {
    headline: headline(reason, event),
    lines: [
      { label: "Artifact", value: artifact.title || artifact.name, untrusted: true },
      { label: "Id", value: artifact.id },
      { label: "By", value: `@${event.by}`, untrusted: true },
      ...details(event),
    ],
    next:
      event.kind === "version" || event.kind === "rename"
        ? `coforge artifact read ${artifact.id}`
        : event.kind === "review"
          ? `coforge artifact comments ${artifact.id} --review ${event.review.id}`
          : `coforge artifact comments ${artifact.id}`,
  };
}
