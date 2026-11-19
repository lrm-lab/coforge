import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decodeTeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { manageTeamMemory } from "#src/server/team-memory/management.server";
import { readTeamMemoryDecisionGraph } from "#src/server/db/repositories/team-memory-decision-graph.server";
import { TeamMemoryError } from "#src/server/team-memory/memory";

export const memoryCommand = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((input: unknown) => decodeTeamMemoryCommand(input))
  .handler(async ({ data, context }) => ({
    ...(await manageTeamMemory(
      context.db,
      { workspaceId: context.workspaceId, userId: context.user.id },
      data,
    )),
    reviewEnabled: Bun.env.COFORGE_TEAM_MEMORY_REVIEW === "true",
  }));

export const memoryDetail = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      id: z.uuid(),
      revision: z.number().int().positive().max(2_147_483_647).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const actor = { workspaceId: context.workspaceId, userId: context.user.id };
    const detail = {
      ...(await manageTeamMemory(context.db, actor, { operation: "get", ...data })),
      reviewEnabled: Bun.env.COFORGE_TEAM_MEMORY_REVIEW === "true",
    };
    const entry = detail.kind === "ready" ? detail.result.entries[0] : undefined;
    if (!entry) return { detail };
    try {
      const graph = await readTeamMemoryDecisionGraph(context.db, actor, {
        id: entry.id,
        revision: entry.revision,
      });
      return { detail, graph };
    } catch (error) {
      if (error instanceof TeamMemoryError) return { detail };
      throw error;
    }
  });
