import type { z } from "zod";
import { verifyDaemonApiKey } from "./daemon-api-key.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";

/** The daemon behind a Bearer API key and the database it was verified against, or the error response. */
export async function authenticateDaemon(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer "))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = getDatabaseClient();
  if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
  try {
    const principal = await verifyDaemonApiKey(
      header.slice(7).trim(),
      new PrismaDaemonApiKeyRepository(db),
    );
    return { principal, db };
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}

/**
 * As `authenticateDaemon`, for a route a Computer may call only while it is still linked to the
 * Workspace its key names; an unlinked Computer gets 403.
 */
export async function authenticateLinkedDaemon(request: Request) {
  const daemon = await authenticateDaemon(request);
  if (daemon instanceof Response) return daemon;
  const { principal, db } = daemon;
  const link = await db.workspaceComputer.findUnique({
    where: {
      workspaceId_computerId: {
        workspaceId: principal.workspaceId,
        computerId: principal.computerId,
      },
    },
    select: { id: true },
  });
  return link ? daemon : Response.json({ error: "forbidden" }, { status: 403 });
}

/** The parsed request body, or the error response. */
export async function parseBody<T>(request: Request, schema: z.ZodType<T>) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const input = schema.safeParse(body);
  return input.success ? input.data : Response.json({ error: "bad request" }, { status: 400 });
}
