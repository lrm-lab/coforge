import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { decodePlatformMemoryCommand } from "@lrm/coforge-sdk/agent";
import { runPlatformMemory } from "#src/server/platform-memory/composition.server";

export const managePlatformMemory = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((input: unknown) => decodePlatformMemoryCommand(input))
  .handler(({ context, data }) =>
    runPlatformMemory(
      context.db,
      { kind: "user", workspaceId: context.workspaceId, userId: context.user.id },
      data,
    ),
  );

export const platformMemoryAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) =>
    context.db.agent.findMany({
      where: { workspaceId: context.workspaceId, ownerId: context.user.id, deletedAt: null },
      select: { id: true, name: true, displayName: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
  );
