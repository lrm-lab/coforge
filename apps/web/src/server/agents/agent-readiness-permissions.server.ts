import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  agentReadinessLine,
  type AgentReadinessFacts,
} from "#src/features/agents/profile-panel/agent-readiness-line";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import { PrismaRuntimeAuthAuthorization } from "#src/server/computers/runtime-auth-authorization.server";

export async function agentReadinessPermissions(
  db: Pick<PrismaClient, "workspaceComputer" | "computerRuntime">,
  input: {
    userId: string;
    workspaceId: string;
    memberRole: string | undefined;
    computerId: string | undefined;
    provider: RuntimeProvider | undefined;
    readiness: AgentReadinessFacts;
  },
): Promise<{ canManageRuntimeLogin: boolean; canControlAgentRuntime: boolean }> {
  const canControlAgentRuntime = roleCan(input.memberRole, "controlAgentRuntime");
  const canManageRuntimeLogin =
    agentReadinessLine(input.readiness) === "runtime_login_required" &&
    input.computerId !== undefined &&
    input.provider !== undefined
      ? await new PrismaRuntimeAuthAuthorization(db).canManage({
          userId: input.userId,
          workspaceId: input.workspaceId,
          computerId: input.computerId,
          provider: input.provider,
        })
      : false;
  return { canManageRuntimeLogin, canControlAgentRuntime };
}
