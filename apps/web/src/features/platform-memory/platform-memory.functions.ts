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
