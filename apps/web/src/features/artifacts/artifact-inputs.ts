import { z } from "zod";

import { withinArtifactTitleLimit } from "./artifact-title-limit";

export const artifactInputs = {
  id: z.uuid(),
  version: z.number().int().positive(),
  baseVersion: z.number().int().nonnegative(),
  title: z.string().trim().min(1).refine(withinArtifactTitleLimit),
  description: z.string().max(1000),
  note: z.string().max(500),
  label: z.string().max(60),
};
