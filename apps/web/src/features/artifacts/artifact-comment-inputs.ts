import { z } from "zod";
import {
  ANCHOR_DATA_MAX_BYTES,
  ARTIFACT_ANCHOR_TYPES,
  ARTIFACT_COMMENT_IMAGES_MAX,
  ARTIFACT_REVIEW_IMAGES_MAX,
  ARTIFACT_SHA256_PATTERN,
  COMMENT_BODY_MAX,
  REVIEW_COMMENTS_MAX,
  artifactPathValid,
  type AgentArtifactAnchor,
} from "@lrm/coforge-sdk/agent";
import { PLACE_LABEL_MAX, PLACE_NAME_PATTERN, PLACE_QUOTE_MAX } from "./artifact-page-limits";
import { artifactInputs } from "./artifact-inputs";

export const COMMENT_PAGE_SIZE = 50;

export const COMMENT_MENTIONS_MAX = 10;

export const COMMENT_HANDLES_RESOLVED_MAX = 50;

const noNul = (value: string) => !value.includes("\u0000");

export const commentBody = z.string().trim().min(1).max(COMMENT_BODY_MAX).refine(noNul);

const commentText = z.string().trim().max(COMMENT_BODY_MAX).refine(noNul).default("");

const commentImages = z
  .array(z.string().regex(ARTIFACT_SHA256_PATTERN))
  .max(ARTIFACT_COMMENT_IMAGES_MAX);

export const hasTextOrImage = (comment: {
  body: string;
  images?: readonly unknown[] | undefined;
}) => comment.body !== "" || (comment.images?.length ?? 0) > 0;

const anchorText = (min: number, max: number) => z.string().min(min).max(max).refine(noNul);

const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/u;

export const isVisibleText = (value: string, multiline: boolean) =>
  !HIDDEN.test(value) && (multiline || !value.includes("\n"));

const visibleText = (max: number, multiline: boolean) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => isVisibleText(value, multiline), { message: "hidden characters" });

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

const pageData = z
  .object({
    name: z.string().regex(PLACE_NAME_PATTERN),
    label: visibleText(PLACE_LABEL_MAX, false).optional(),
    quote: visibleText(PLACE_QUOTE_MAX, true).optional(),
  })
  .strict();

export type PlaceData = z.infer<typeof pageData>;

const ANCHOR_DATA = {
  file: noData,
  lines: linesData,
  element: elementData,
  text: textData,
  page: pageData,
} satisfies Record<(typeof ARTIFACT_ANCHOR_TYPES)[number], z.ZodType>;

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

export const commentFields = {
  body: commentText,
  path: filePath.optional(),
  anchor: commentAnchor.optional(),
  replyTo: artifactInputs.id.optional(),
  images: commentImages.optional(),
};

const commentDraft = z.object({ ...commentFields, idempotencyKey: artifactInputs.id });

export const emptyComment = { message: "the comment is empty", path: ["body"] };

export const commentDraftInput = commentDraft.refine(hasTextOrImage, emptyComment);

export const commentInputs = {
  comments: z.object({
    artifact: artifactInputs.id,
    path: filePath.optional(),
    all: z.boolean().optional(),
    review: artifactInputs.id.optional(),
    after: z.string().max(200).optional(),
  }),
  comment: commentDraft
    .extend({ artifact: artifactInputs.id, version: artifactInputs.version.optional() })
    .refine(hasTextOrImage, emptyComment),
  review: z
    .object({
      artifact: artifactInputs.id,
      body: commentBody.optional(),
      comments: z
        .array(z.object(commentFields).strict().refine(hasTextOrImage, emptyComment))
        .min(1)
        .max(REVIEW_COMMENTS_MAX),
      version: artifactInputs.version.optional(),
      idempotencyKey: artifactInputs.id,
    })
    .refine(
      (review) =>
        review.comments.reduce((total, comment) => total + (comment.images?.length ?? 0), 0) <=
        ARTIFACT_REVIEW_IMAGES_MAX,
      { message: "a review carries at most 30 images", path: ["comments"] },
    ),
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
