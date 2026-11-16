import { z } from "zod";
import { commentFields, emptyComment, hasTextOrImage } from "./artifact-comment-inputs";
import { artifactInputs } from "./artifact-inputs";

export const COMMENT_DRAFTS_MAX = 50;

export const COMMENT_DRAFT_EXPIRY_WARNING_DAYS = 5;

export const draftInputs = {
  create: z
    .object({
      artifactId: artifactInputs.id,
      version: artifactInputs.version,
      createdAt: z.coerce.date().optional(),
      ...commentFields,
    })
    .strict()
    .refine(hasTextOrImage, emptyComment),
  edit: z
    .object({ artifactId: artifactInputs.id, draftId: artifactInputs.id, body: commentFields.body })
    .strict(),
  target: z.object({ artifactId: artifactInputs.id, draftId: artifactInputs.id }).strict(),
  submit: z
    .object({
      artifactId: artifactInputs.id,
      draftIds: z.array(artifactInputs.id).min(1).max(COMMENT_DRAFTS_MAX),
      clientKey: artifactInputs.id,
    })
    .strict(),
};

export type DraftCreateInput = z.infer<(typeof draftInputs)["create"]>;

export type DraftRefusalReason =
  | "mention-cannot-see"
  | "too-many-mentions"
  | "file-gone"
  | "version-gone"
  | "reply-gone"
  | "invalid";
