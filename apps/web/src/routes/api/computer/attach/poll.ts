import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";

import { parseBody } from "#src/server/auth/daemon-request.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { pollAttachSession } from "#src/server/computers/computer-attach.server";

const pollSchema = z.object({ deviceCode: z.string().min(1).max(200) });

/** `attach/poll` (task #417): the machine trades its deviceCode for the one-shot attachToken,
 * answering the OAuth device flow's statuses — `attach_pending`, `slow_down` under the
 * interval, `expired_token` past the session, `access_denied` where the person refused. */
export const Route = createFileRoute("/api/computer/attach/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await parseBody(request, pollSchema);
        if (body instanceof Response) return body;
        const result = await pollAttachSession(requireDatabaseClient(), body);
        switch (result.kind) {
          case "pending":
            return Response.json({ error: "attach_pending" }, { status: 400 });
          case "slow_down":
            return Response.json({ error: "slow_down" }, { status: 400 });
          case "expired":
            return Response.json({ error: "expired_token" }, { status: 400 });
          case "denied":
            return Response.json({ error: "access_denied" }, { status: 400 });
          case "token":
            return Response.json(
              { attachToken: result.attachToken, expiresInSeconds: result.expiresInSeconds },
              { status: 200 },
            );
        }
      },
    },
  },
});
