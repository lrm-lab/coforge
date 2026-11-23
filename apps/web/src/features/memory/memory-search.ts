import { z } from "zod";

export const teamMemorySearch = z.object({
  q: z.string().max(500).catch(""),
  archived: z.boolean().catch(false),
  offset: z.number().int().min(0).max(100000).catch(0),
  project: z.uuid().optional().catch(undefined),
  review: z.boolean().optional().catch(undefined),
  after: z.uuid().optional().catch(undefined),
  revision: z.number().int().positive().max(2_147_483_647).optional().catch(undefined),
  id: z
    .union([z.uuid(), z.literal("new")])
    .optional()
    .catch(undefined),
});

export const personalMemorySearch = z.object({
  create: z.boolean().catch(false),
  agent: z.uuid().optional().catch(undefined),
  key: z
    .string()
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional()
    .catch(undefined),
  q: z.string().max(500).catch(""),
  archived: z.boolean().catch(false),
  offset: z.number().int().min(0).max(100000).catch(0),
  agentQuery: z.string().max(100).catch(""),
  page: z.number().int().min(1).max(5000).catch(1),
});
