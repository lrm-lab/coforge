import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decodeLocalMemoryCommand } from "@lrm/coforge-sdk/agent";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { personalMemoryManagement } from "#src/server/agents/agent-memory-composition.server";
import { paginated } from "#src/server/db/pagination.server";

export const listMyMemoryAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      query: z.string().max(100).default(""),
      selected: z.uuid().optional(),
      page: z.number().int().min(1).max(5000).default(1),
    }),
  )
  .handler(async ({ data, context }) => {
    const [[agents, meta], selected] = await Promise.all([
      paginated(context.db)
        .agent.paginate({
          where: {
            workspaceId: context.workspaceId,
            ownerId: context.user.id,
            deletedAt: null,
            ...(data.query
              ? {
                  OR: [
                    { displayName: { contains: data.query, mode: "insensitive" as const } },
                    { name: { contains: data.query, mode: "insensitive" as const } },
                  ],
                }
              : {}),
          },
          select: { id: true, name: true, displayName: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        })
        .withPages({ limit: 20, page: data.page }),
      data.selected
        ? context.db.agent.findFirst({
            where: {
              id: data.selected,
              workspaceId: context.workspaceId,
              ownerId: context.user.id,
              deletedAt: null,
            },
            select: { id: true, name: true, displayName: true },
          })
        : Promise.resolve(null),
    ]);
    return { agents, selected, hasNextPage: meta.nextPage !== null };
  });
export const personalMemoryCommand = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({ agentId: z.uuid(), command: z.unknown().transform(decodeLocalMemoryCommand) }),
  )
  .handler(({ data, context }) =>
    personalMemoryManagement(context.db).execute(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data.agentId,
      data.command,
    ),
  );
