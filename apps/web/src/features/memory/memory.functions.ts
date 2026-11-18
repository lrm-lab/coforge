import { createServerFn } from "@tanstack/react-start";
import { decodeTeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { manageTeamMemory } from "#src/server/team-memory/management.server";

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
