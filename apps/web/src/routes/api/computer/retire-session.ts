import { createFileRoute } from "@tanstack/react-router";

import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { retireComputerSession } from "#src/server/computers/computer-attach.server";

/** `retire-session` (task #417): a Computer retires the login its setup left behind. The Bearer
 * is that login — a Computer access token — and `x-coforge-computer-key` is the machine's own
 * `sk_computer`, so only the device login its owner holds retires. A browser
 * login is refused outright, a repeat answers `already_retired`, and nothing on the machine is
 * deleted unless the answer is a definite one. */
export const Route = createFileRoute("/api/computer/retire-session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const computerKey = request.headers.get("x-coforge-computer-key")?.trim();
        const userToken = request.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "")
          .trim();
        if (!computerKey || !userToken)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        let principal;
        try {
          principal = await verifyDaemonApiKey(
            computerKey,
            new PrismaDaemonApiKeyRepository(requireDatabaseClient()),
          );
        } catch {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (principal.kind !== "computer")
          return Response.json(
            { error: "only an sk_computer may retire a login" },
            { status: 403 },
          );
        const result = await retireComputerSession(requireDatabaseClient(), {
          userToken,
          principal,
        });
        switch (result.kind) {
          case "retired":
            return Response.json({ status: "retired" }, { status: 200 });
          case "already_retired":
            return Response.json({ status: "already_retired" }, { status: 200 });
          case "session_not_device":
            return Response.json({ error: "session_not_device" }, { status: 403 });
          case "wrong_owner":
            return Response.json({ error: "session_not_device" }, { status: 403 });
        }
      },
    },
  },
});
