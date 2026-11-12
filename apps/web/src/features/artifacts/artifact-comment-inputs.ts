import { z } from "zod";
import {
  ANCHOR_DATA_MAX_BYTES,
  ARTIFACT_ANCHOR_TYPES,
  COMMENT_BODY_MAX,
  REVIEW_COMMENTS_MAX,
  artifactPathValid,
  type AgentArtifactAnchor,
} from "@lrm/coforge-sdk/agent";
import { artifactInputs } from "./artifact-inputs";

/**
 * The shape of every comment input: one set of rules for every client that comments, so a
 * comment one of them takes the others take too.
 */

/** A page of `comments`. */
export const COMMENT_PAGE_SIZE = 50;

/** Text, with no NUL, which would store it as binary (as a document's text is refused). */
const noNul = (value: string) => !value.includes("\u0000");

export const commentBody = z.string().trim().min(1).max(COMMENT_BODY_MAX).refine(noNul);

const anchorText = (min: number, max: number) => z.string().min(min).max(max).refine(noNul);

const filePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(artifactPathValid, { message: "not a file path" });

const noData = z.object({}).strict();
const position = z.number().int().min(1);
const linesData = z
  .object({ start: position, end: position })
  .strict()
  .refine((lines) => lines.end >= lines.start, { message: "end before start" });
const elementData = z
  .object({ selector: anchorText(1, 1024), quote: anchorText(0, 4000).optional() })
  .strict();
const textData = z
  .object({
    quote: anchorText(1, 4000),
    prefix: anchorText(0, 1000).optional(),
    suffix: anchorText(0, 1000).optional(),
  })
  .strict();

/** The shape each anchor type's `data` has; a type without an entry here does not type-check. */
const ANCHOR_DATA = {
  file: noData,
  lines: linesData,
  element: elementData,
  text: textData,
} satisfies Record<(typeof ARTIFACT_ANCHOR_TYPES)[number], z.ZodType>;

/** Where a comment points inside its file: `{ type, data }`, `data` at most 4 KiB as JSON and the
 * shape its type names: `file` `{}`, `lines` `{ start, end }` (1-based), `element` `{ selector,
 * quote? }`, `text` `{ quote, prefix?, suffix? }`. */
export const commentAnchor = z
  .object({ type: z.enum(ARTIFACT_ANCHOR_TYPES), data: z.record(z.string(), z.unknown()) })
  .strict()
  .superRefine((anchor, context) => {
    const data = ANCHOR_DATA[anchor.type].safeParse(anchor.data);
    if (!data.success) {
      for (const issue of data.error.issues)
        context.addIssue({ code: "custom", message: issue.message, path: ["data", ...issue.path] });
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(anchor.data)).length > ANCHOR_DATA_MAX_BYTES)
      context.addIssue({ code: "custom", message: "anchor data is over 4 KiB", path: ["data"] });
  });

/** The fields a comment has, alone and inside a review. */
const commentFields = {
  body: commentBody,
  path: filePath.optional(),
  anchor: commentAnchor.optional(),
  replyTo: artifactInputs.id.optional(),
};

export const commentInputs = {
  comments: z.object({
    artifact: artifactInputs.id,
    path: filePath.optional(),
    all: z.boolean().optional(),
    review: artifactInputs.id.optional(),
    after: z.string().max(200).optional(),
  }),
  comment: z.object({
    artifact: artifactInputs.id,
    ...commentFields,
    version: artifactInputs.version.optional(),
    idempotencyKey: artifactInputs.id,
  }),
  review: z.object({
    artifact: artifactInputs.id,
    body: commentBody.optional(),
    comments: z.array(z.object(commentFields).strict()).min(1).max(REVIEW_COMMENTS_MAX),
    version: artifactInputs.version.optional(),
    idempotencyKey: artifactInputs.id,
  }),
  resolve: z.object({
    artifact: artifactInputs.id,
    comment: artifactInputs.id,
    note: commentBody.optional(),
  }),
  reopen: z.object({ artifact: artifactInputs.id, comment: artifactInputs.id }),
};

export type CommentAnchor = AgentArtifactAnchor;
export type CommentInput = z.infer<(typeof commentInputs)["comment"]>;
export type ReviewInput = z.infer<(typeof commentInputs)["review"]>;
