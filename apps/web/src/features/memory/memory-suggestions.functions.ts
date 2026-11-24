import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  listMemorySuggestions,
  reviewMemorySuggestion,
  submitMemorySuggestion,
} from "#src/server/team-memory/suggestion-review.server";
import { scanTeamMemorySuggestions } from "#src/server/team-memory/suggestion-scan.server";
import { TeamMemoryError } from "#src/server/team-memory/memory";

const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), after: z.uuid().optional() }).strict(),
  z.object({ operation: z.literal("scan") }).strict(),
  z.object({ operation: z.literal("submit"), draft: z.unknown() }).strict(),
  z
    .object({
      operation: z.enum(["accept", "dismiss", "verify"]),
      id: z.uuid(),
      edit: z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          content: z.string().trim().min(1).max(16_000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const memorySuggestionCommand = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((input: unknown) => command.parse(input))
  .handler(async ({ context, data }) => {
    const { db, workspaceId, user } = context;
    if (Bun.env.COFORGE_TEAM_MEMORY_REVIEW !== "true")
      return { kind: "error" as const, error: "review_disabled" as const };
    try {
      const actor = { workspaceId, userId: user.id };
      if (data.operation === "list")
        return { kind: "list" as const, ...(await listMemorySuggestions(db, actor, data.after)) };
      if (data.operation === "scan")
        return {
          kind: "scan" as const,
          ...(await scanTeamMemorySuggestions(db, workspaceId, user.id)),
        };
      if (data.operation === "submit")
        return {
          kind: "queued" as const,
          ...(await submitMemorySuggestion(db, actor, data.draft)),
        };
      return {
        kind: "decision" as const,
        ...(await reviewMemorySuggestion(db, actor, data.id, data.operation, data.edit)),
      };
    } catch (error) {
      if (error instanceof TeamMemoryError) return { kind: "error" as const, error: error.code };
      throw error;
    }
  });
