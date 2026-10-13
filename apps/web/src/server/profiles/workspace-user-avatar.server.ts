import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { readUserAvatar } from "./user-avatar.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";

export async function handleWorkspaceUserAvatar(
  request: Request,
  workspaceId: string,
  userId: string,
  dependencies: {
    authenticate?: (
      cookie: string | undefined,
    ) => { id: string } | null | Promise<{ id: string } | null>;
    database?: () => PrismaClient | null | undefined;
    read?: typeof readUserAvatar;
  } = {},
) {
  try {
    const authenticate = dependencies.authenticate ?? ((cookie) => optionalBrowserUser(cookie));
    const viewer = await authenticate(request.headers.get("cookie") ?? undefined);
    if (!viewer) throw new AppError("ACCESS_DENIED");
    const db = (dependencies.database ?? getDatabaseClient)();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const visible = await db.workspaceMembership.findFirst({
      where: {
        workspaceId,
        userId,
        workspace: { members: { some: { userId: viewer.id } } },
      },
      select: { userId: true },
    });
    if (!visible) throw new AppError("NOT_FOUND");
    const avatar = await (dependencies.read ?? readUserAvatar)(db, userId);
    return new Response(avatar.body, {
      headers: privateImageHeaders(avatar.contentType),
    });
  } catch (error) {
    return privateResourceRefusal(error);
  }
}
