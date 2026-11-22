import { z } from "zod";
import { isValidWorkspaceSlug } from "./workspace-slug";

const workspaceSlug = z.string().refine(isValidWorkspaceSlug);

export const WORKSPACE_NAME_MAX_LENGTH = 100;

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
  slug: workspaceSlug,
});

export const renameWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
});

export const changeWorkspaceSlugInputSchema = z.object({
  slug: z.string().trim().pipe(workspaceSlug),
});

export const deleteWorkspaceInputSchema = z.object({
  confirmSlug: z.string().max(200),
});

export const workspaceIconUploadInput = z
  .instanceof(FormData)
  .transform((form) => ({ file: form.get("file") }))
  .pipe(z.object({ file: z.instanceof(File) }));
