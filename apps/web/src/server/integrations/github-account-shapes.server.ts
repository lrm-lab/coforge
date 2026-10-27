import { z } from "zod";

export const userSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1).max(100),
});
export const tokensSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86400),
  refresh_token_expires_in: z.number().int().positive().max(31536000),
  token_type: z.literal("bearer"),
});
export const credentialsSchema = tokensSchema.pick({ access_token: true, refresh_token: true });
export const idSchema = z.number().int().positive().safe();
export const pageSchema = z.number().int().min(1).max(10000);
export const installationsSchema = z.object({
  total_count: z.number().int().nonnegative().max(300_000),
  installations: z
    .array(
      z.object({
        id: idSchema,
        app_id: idSchema,
        account: z.object({ login: z.string().min(1).max(100), type: z.string().optional() }),
        repository_selection: z.enum(["all", "selected"]),
        suspended_at: z.string().nullable().optional(),
        html_url: z
          .string()
          .url()
          .refine((value) => new URL(value).hostname === "github.com")
          .optional(),
      }),
    )
    .max(30),
});
export const repositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z
    .array(
      z.object({
        id: idSchema,
        full_name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .max(300),
        private: z.boolean(),
      }),
    )
    .max(30),
});
export const publicRepositorySchema = z.object({
  id: idSchema,
  full_name: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(300),
  private: z.boolean(),
  html_url: z
    .string()
    .url()
    .refine((value) => new URL(value).hostname === "github.com"),
});
