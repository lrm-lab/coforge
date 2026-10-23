import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { agentIdSchema } from "#src/features/agents/agent.schemas";
import { createInstallationAgentScope } from "#src/server/app-agent-access/app-agent-access-composition.server";
import { AGENT_ACCESS_MODES, AGENT_ACCESS_SELECTION_MAX } from "./agent-access-scope";
import { APP_KEY_MAX_LENGTH } from "./app-registration";

/**
 * Which Agents may use an app installed in the Workspace. Thin wrappers over
 * `server/app-agent-access/`, which decides who may read the selection and who may change it.
 */

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** The installation's mode and Agent count, and for an owner or admin the selection. */
export const loadAppAgentAccessScope = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return createInstallationAgentScope(context.db).view(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data.key,
    );
  });

/** Sets who may use the app, at once (owner or admin; the last write wins). Revokes no grant. */
export const setAppAgentAccessScope = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    keyInput.extend({
      mode: z.enum(AGENT_ACCESS_MODES),
      agentIds: z.array(agentIdSchema).max(AGENT_ACCESS_SELECTION_MAX),
    }),
  )
  .handler(async ({ data, context }) => {
    declareNoStore();
    return createInstallationAgentScope(context.db).set(
      { workspaceId: context.workspaceId, userId: context.user.id },
      data.key,
      { mode: data.mode, agentIds: data.agentIds },
    );
  });
