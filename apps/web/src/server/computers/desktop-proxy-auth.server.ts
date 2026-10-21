import type { PrismaClient } from "#src/generated/prisma/client";

import { readBrowserSession } from "#src/server/auth/browser-login.server";

const DESKTOP_PATH = /^\/desktop\/([A-Za-z0-9_-]+)(?:\/|$)/;

/** The cloud computer named by a desktop path, or nothing when the path is not one. */
export function desktopComputerId(path: string): string | undefined {
  const pathname = path.split("?", 1)[0] ?? "";
  return DESKTOP_PATH.exec(pathname)?.[1];
}

export type DesktopAccess = "allow" | "unauthenticated" | "forbidden";

/**
 * Caddy may forward a desktop only when the signed-in user owns that cloud computer.
 * A missing path and a computer the user does not own are the same refusal.
 */
export function decideDesktopAccess(input: {
  computerId: string | undefined;
  signedIn: boolean;
  ownsCloudComputer: boolean;
}): DesktopAccess {
  if (!input.signedIn) return input.computerId ? "unauthenticated" : "forbidden";
  if (!input.computerId || !input.ownsCloudComputer) return "forbidden";
  return "allow";
}

export async function userOwnsCloudComputer(
  db: Pick<PrismaClient, "computer">,
  userId: string,
  computerId: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(computerId)) {
    return false;
  }
  const row = await db.computer.findFirst({
    where: { id: computerId, ownerId: userId, kind: "cloud" },
    select: { id: true },
  });
  return row !== null;
}

const noStore = { "cache-control": "no-store" };

/** The answer Caddy's forward_auth reads. 200 continues the proxy; anything else stops it. */
export async function authorizeDesktopRequest(input: {
  desktopPath: string;
  cookieHeader: string;
  sessionSecret: string;
  ownsCloudComputer: (userId: string, computerId: string) => Promise<boolean>;
}): Promise<Response> {
  const user = readBrowserSession({
    sessionSecret: input.sessionSecret,
    cookieHeader: input.cookieHeader,
  });
  const computerId = desktopComputerId(input.desktopPath);
  const owns =
    user !== null && computerId !== undefined
      ? await input.ownsCloudComputer(user.id, computerId)
      : false;
  const decision = decideDesktopAccess({
    computerId,
    signedIn: user !== null,
    ownsCloudComputer: owns,
  });
  if (decision === "allow") return new Response(null, { status: 200, headers: noStore });
  if (decision === "unauthenticated") return new Response(null, { status: 401, headers: noStore });
  return new Response(null, { status: 403, headers: noStore });
}
