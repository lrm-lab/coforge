import { z } from "zod";

/**
 * The shape of every document input (task #385), one set of rules for the web page's server
 * functions and the Agent API (`coforge artifact`), so a request one of them takes the other
 * takes too.
 */
export const artifactInputs = {
  id: z.uuid(),
  version: z.number().int().positive(),
  baseVersion: z.number().int().nonnegative(),
  /** A document's text: at most 2 MiB once encoded, which the service checks in bytes, and no
   * NUL, which would store it as binary. */
  text: z
    .string()
    .max(2 * 1024 * 1024)
    .refine((value) => !value.includes("\u0000")),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000),
  note: z.string().max(500),
  label: z.string().max(60),
  historyLimit: z.number().int().min(1).max(50),
};
