import { createFileRoute } from "@tanstack/react-router";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import { hashDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { detachComputer } from "#src/server/computers/computer-self.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";

/**
 * `POST /api/computer/detach` (task #417): a Computer asks to leave a Workspace. A key the
 * server still has but that is revoked or whose Computer is already unlinked answers a
 * definite `computer_key_revoked` — the machine's local half may go right away rather than
 * retrying an answer it can never get. A key the server never knew still answers 401, which
 * the machine does not read as confirmed.
 */
const revoked = () => Response.json({ error: "computer_key_revoked" }, { status: 410 });

export const Route = createFileRoute("/api/computer/detach")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateLinkedDaemon(request);
        if (daemon instanceof Response) {
          // A revoked or unlinked key is the one case "no" is as good as "yes": the server has
          // already done the work detach asks for, and that answer is definite — without it the
          // Computer retries forever on a machine the web already removed (task #417).
          const header = request.headers.get("authorization");
          const db = getDatabaseClient();
          if (header?.startsWith("Bearer ") && db) {
            const record = await new PrismaDaemonApiKeyRepository(db).findByHash(
              hashDaemonApiKey(header.slice(7).trim()),
            );
            if (
              record &&
              (record.revokedAt ||
                !(await db.workspaceComputer.findUnique({
                  where: {
                    workspaceId_computerId: {
                      workspaceId: record.workspaceId,
                      computerId: record.computerId,
                    },
                  },
                })))
            )
              return revoked();
          }
          return daemon;
        }
        const { principal, db } = daemon;
        const api = createCentrifugoServerApi();
        return detachComputer(
          db,
          api,
          (computerId) => getWorkspaceComputerInvalidation().notify(computerId),
          principal,
        );
      },
    },
  },
});
