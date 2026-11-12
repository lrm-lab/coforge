import type { AgentArtifactAnchor, AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { invalidArgument } from "#src/command-help/index";
import { optional, parseFlags, type FlagSpec } from "#src/artifact-flags";

/**
 * `coforge artifact comments|comment|review|resolve|reopen`: what each takes on the command line.
 * The words of a comment (or the JSON of a review) come from stdin, read when the command runs.
 * What a value means is the server's to judge; only `--lines` is expanded here, into the anchor it
 * stands for, and the `c_` a printed comment id carries is dropped.
 */
export const COMMENT_OPERATIONS = ["comments", "comment", "review", "resolve", "reopen"] as const;
export type CommentOperation = (typeof COMMENT_OPERATIONS)[number];

export const isCommentOperation = (operation: string): operation is CommentOperation =>
  (COMMENT_OPERATIONS as readonly string[]).includes(operation);

type Request<T extends CommentOperation> = Extract<AgentArtifactRequest, { operation: T }>;

/** A request before its text is read and its idempotency key made. */
export type ArtifactCommentDraft =
  | Request<"comments">
  | Omit<Request<"comment">, "body" | "idempotencyKey">
  | Omit<Request<"review">, "body" | "comments" | "idempotencyKey">
  | Request<"resolve">
  | Request<"reopen">;

export type ArtifactCommentInvocation = {
  command: "artifact";
  comment: ArtifactCommentDraft;
  json?: boolean;
};

const FLAGS: Record<CommentOperation, FlagSpec> = {
  comments: { text: ["--path", "--review", "--after"], bool: ["--all"], positionals: 1 },
  comment: { text: ["--path", "--lines", "--reply-to"], count: ["--rev"], positionals: 1 },
  review: { count: ["--rev"], positionals: 1 },
  resolve: { text: ["--note"], positionals: 2 },
  reopen: { positionals: 2 },
};

/** A comment id as `comments` prints it (`c_<id>`) or as the bare id. */
export const commentIdOf = (text: string) => (text.startsWith("c_") ? text.slice(2) : text);

/** The `lines` anchor that `N` (one line) or `a-b` stands for, or `undefined` for any other text. */
export function linesAnchor(text: string): AgentArtifactAnchor | undefined {
  const [, first, last] = /^(\d+)(?:-(\d+))?$/.exec(text) ?? [];
  if (!first) return undefined;
  const start = Number(first);
  return { type: "lines", data: { start, end: last === undefined ? start : Number(last) } };
}

export function parseCommentArgs(
  operation: CommentOperation,
  args: readonly string[],
): ArtifactCommentInvocation {
  const command = `artifact ${operation}`;
  const { positionals, text, count, switches, json } = parseFlags(command, args, FLAGS[operation]);
  const [artifact, comment] = positionals;
  if (!artifact) throw invalidArgument(command, "Name the artifact: its id, as create printed it");
  const draft = (): ArtifactCommentDraft => {
    switch (operation) {
      case "comments":
        return {
          operation,
          artifact,
          ...optional("path", text["--path"]),
          ...(switches.has("--all") ? { all: true } : {}),
          ...optional("review", text["--review"]),
          ...optional("after", text["--after"]),
        };
      case "comment": {
        const at = text["--lines"];
        const anchor = at === undefined ? undefined : linesAnchor(at);
        if (at !== undefined && !anchor)
          throw invalidArgument(command, `--lines takes a line N or a range a-b, not "${at}"`);
        return {
          operation,
          artifact,
          ...optional("path", text["--path"]),
          ...optional("anchor", anchor),
          ...optional("replyTo", text["--reply-to"] && commentIdOf(text["--reply-to"])),
          ...optional("version", count["--rev"]),
        };
      }
      case "review":
        return { operation, artifact, ...optional("version", count["--rev"]) };
      case "resolve":
      case "reopen":
        if (!comment)
          throw invalidArgument(
            command,
            "Name the comment: its id as comments printed it (c_<id>)",
          );
        return {
          operation,
          artifact,
          comment: commentIdOf(comment),
          ...(operation === "resolve" ? optional("note", text["--note"]) : {}),
        };
    }
  };
  return { command: "artifact", comment: draft(), ...(json ? { json: true } : {}) };
}
