import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PiChatGateway } from "./pi-chat-gateway.server";

export function piChatConfiguration() {
  const origin = (Bun.env.COFORGE_PI_CHAT_ORIGIN ?? Bun.env.COFORGE_CLOUD_DESKTOP_ORIGIN)?.trim();
  const secret = Bun.env.COFORGE_CLOUD_CLUSTER_TOKEN;
  if (!origin || !secret || secret.length < 16) return undefined;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return { origin: url.origin, secret };
  } catch {
    return undefined;
  }
}

export function productionPiChat(db: PrismaClient) {
  const config = piChatConfiguration();
  if (!config) throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "pi-chat-unconfigured" });
  return new PiChatGateway({
    ...config,
    fetch,
    canUse: async (scope) =>
      !!(await db.computer.findFirst({
        where: {
          id: scope.computerId,
          ownerId: scope.userId,
          kind: "cloud",
          deletedAt: null,
          workspaces: { some: { workspaceId: scope.workspaceId } },
        },
        select: { id: true },
      })),
  });
}
