import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { parseBody } from "#src/server/auth/daemon-request.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";
import { startAttachSession } from "#src/server/computers/computer-attach.server";

import { computerAttachCreationRateLimit } from "#src/server/computers/computer-attach-session-http.server";

const startSchema = z.object({
  machineName: z.string().min(1).max(200),
  hostname: z.string().min(1).max(200),
  os: z.string().min(1).max(100),
});

/** `attach/start` (task #417): a machine reports itself and opens an attach session. The
 * deviceCode it answers is the machine's poll secret — never in the link — while the short
 * userCode and the approval URL are what the person sees and compares. */
export const Route = createFileRoute("/api/computer/attach/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // attach/start is unauthenticated and writes a row per call — the per-IP fixed window
        // keeps one address from opening unbounded sessions (task #417).
        const ip = clientAddress(request) ?? "unknown";
        const limit = computerAttachCreationRateLimit();
        if (limit) {
          const decision = await limit.admit(ip);
          if (!decision.allowed)
            return Response.json(
              { error: "rate_limited" },
              { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
            );
        }
        const body = await parseBody(request, startSchema);
        if (body instanceof Response) return body;
        const session = await startAttachSession(requireDatabaseClient(), {
          ...body,
          origin: publicOrigin(request),
        });
        return Response.json(session, { status: 200 });
      },
    },
  },
});
