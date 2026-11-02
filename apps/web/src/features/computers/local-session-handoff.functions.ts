import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { HANDOFF_RUNTIME_PROVIDERS } from "@lrm/coforge-sdk/internal";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerLocalSessions } from "#src/server/computers/computer-local-sessions-production.server";
import { assertCanCreateAgents } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

const searchInput = z.object({
  computerId: z.uuid(),
  query: z.string().max(200).default(""),
});
const excerptInput = z.object({
  computerId: z.uuid(),
  provider: z.enum(HANDOFF_RUNTIME_PROVIDERS),
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes("\0")),
});

async function authorizeCreate(
  db: Parameters<typeof workspaceMemberRole>[0],
  workspaceId: string,
  userId: string,
) {
  const role = await workspaceMemberRole(db, workspaceId, userId);
  if (!role) throw new Error("Workspace is not available");
  assertCanCreateAgents(role);
}

/** Lists or searches this User's local Claude Code and Codex sessions on one owned Computer. */
export const searchLocalSessions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(searchInput)
  .handler(async ({ data, context: { db, user, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    await authorizeCreate(db, workspaceId, user.id);
    return computerLocalSessions(db).search(
      { userId: user.id, workspaceId },
      data.computerId,
      data.query,
    );
  });

/** Reads a bounded, conversation-only briefing for a selected local session. */
export const readLocalSessionExcerpt = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(excerptInput)
  .handler(async ({ data, context: { db, user, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    await authorizeCreate(db, workspaceId, user.id);
    return computerLocalSessions(db).excerpt(
      { userId: user.id, workspaceId },
      data.computerId,
      data.provider,
      data.sessionId,
      data.cwd,
    );
  });
