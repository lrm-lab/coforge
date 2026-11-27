import { COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal/computer-attach-session";
import type { PrismaClient } from "#src/generated/prisma/client";

export function markComputerAttachReady(
  db: Pick<PrismaClient, "$executeRaw">,
  scope: { workspaceId: string; computerId: string; apiKeyHash: string },
  readyAt = new Date(),
): Promise<number> {
  return db.$executeRaw`
    UPDATE computer_attach_sessions AS session
       SET status = 'ready', ready_at = ${readyAt}
     WHERE session.protocol_major = ${COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR}
       AND session.status = 'bound'
       AND session.target_workspace_id = ${scope.workspaceId}::uuid
       AND session.approved_workspace_id = ${scope.workspaceId}::uuid
       AND session.candidate_computer_id = ${scope.computerId}::uuid
       AND session.activated_key_hash = ${scope.apiKeyHash}
       AND EXISTS (
         SELECT 1 FROM daemon_api_keys AS credential
           JOIN workspace_memberships AS member
             ON member."workspaceId" = credential.workspace_id AND member."userId" = credential.owner_id
           JOIN workspace_computers AS binding
             ON binding."workspaceId" = credential.workspace_id AND binding."computerId" = credential.computer_id
          WHERE credential.api_key_hash = ${scope.apiKeyHash}
            AND credential.workspace_id = session.approved_workspace_id
            AND credential.computer_id = session.candidate_computer_id
            AND credential.revoked_at IS NULL
       )`;
}
