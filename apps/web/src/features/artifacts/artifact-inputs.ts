import { z } from "zod";

import { ARTIFACT_TITLE_MAX } from "./artifact-title-limit";

/**
 * The shape of every artifact input (task #385), one set of rules for the web page's server
 * functions and the Agent API (`coforge artifact`), so a request one of them takes the other
 * takes too.
 */
export const artifactInputs = {
  id: z.uuid(),
  version: z.number().int().positive(),
  baseVersion: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(ARTIFACT_TITLE_MAX),
  description: z.string().max(1000),
  note: z.string().max(500),
  label: z.string().max(60),
};
