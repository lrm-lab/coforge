import { z } from "zod";

/** Why the Agent prepared this for a human. Shown below the card form; not the action itself. */
export const draftHintSchema = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .describe(
    "Why the agent prepared this for you. Shows below the form on the card; not the action itself.",
  );
