import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { loadAgentTokenUsage } from "#src/server/agents/agent-token-usage.server";

const agentTokenUsageInput = z
  .object({
    agentId: z.uuid(),
    range: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)]),
    timeZone: z.string().max(128).nullable().optional(),
  })
  .strict();

export const getAgentTokenUsage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentTokenUsageInput)
  .handler(({ context, data }) => {
    declareNoStore();
    return loadAgentTokenUsage(context, data);
  });
