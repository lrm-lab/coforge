import type { PrismaClient } from "#src/generated/prisma/client";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { AppRegistry } from "#src/server/apps/app-registry.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { AppRecoverOwnerActionCards } from "#src/server/conversations/app-recover-owner-action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import { workspace } from "./share-link-fixture";

/**
 * Shared by the Agent app-management integration tests: a Workspace (Marketplace flags on unless
 * `flag` is `off`) with an app owned by the Agent `scout`, an admin-role Agent `boss`, a plain Agent
 * `other` and a spare Agent to hand the app to, and the services acting for them. A test file calls
 * `registerShareFixture()` (`share-link-fixture.ts`) once at its top level.
 */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString(
  "base64",
);
export const NOT_FOUND = { code: "NOT_FOUND", errorId: undefined } as const;
export const ORIGIN = "https://coforge.example";

function memoryStorage() {
  const objects = new Map<string, Blob>();
  const storage: FileStorage = {
    put: async (key, file) => void objects.set(key, file),
    open: async (key) => {
      const body = objects.get(key);
      return body ? { body, contentType: null, sizeBytes: body.size } : null;
    },
    remove: async (key) => void objects.delete(key),
    head: async () => null,
  };
  return { objects, images: { storage: async () => storage, removalFailed: () => {} } };
}

/** A Workspace with an app owned by `scout`, an admin Agent `boss`, a plain Agent `other`, and a
 * spare Agent to hand the app to. */
export async function fixture(db: PrismaClient, { flag = "on" as "on" | "off" } = {}) {
  const ws = await workspace(db, "Acme Labs", { flag });
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = (name: string, role = "member", extra: Record<string, unknown> = {}) =>
    db.agent.create({
      data: {
        workspaceId: ws.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: ws.people.member.id,
        role,
        runtimeConfig: {},
        ...extra,
      },
    });
  const [scout, boss, other, spare] = [
    await agent("scout"),
    await agent("boss", "admin"),
    await agent("other"),
    await agent("spare"),
  ];
  const key = `mgmt-${suffix}`;
  await createAppRegistry(db).registerApp(ws.actor("owner"), {
    key,
    name: "Acme Notes",
    description: "Notes for the team.",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: ["https://notes.acme.example/cb"],
    category: "productivity",
    allowedScopes: ["openid", "profile", "identity"],
  });
  await db.app.update({ where: { key }, data: { ownerAgentId: scout.id } });
  const memory = memoryStorage();
  const management = new AppAgentManagement(
    createAppOwnerAgents(db),
    new AppRegistry(new PrismaAppRegistryStore(db), memory.images),
    createAppShareLinks(db),
    createAppPublishing(db),
  );
  const channel = await db.conversation.create({
    data: {
      workspaceId: ws.id,
      channelName: `mgmt-ch-${suffix}`,
      members: {
        create: [
          ...Object.values(ws.people).map((user) => ({ userId: user.id })),
          ...[scout, boss, other, spare].map((a) => ({ agentId: a.id })),
        ],
      },
    },
  });
  const cards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
    async memberChanged() {},
    async messageAvailable() {},
  });
  return {
    ws,
    key,
    scout,
    boss,
    other,
    spare,
    memory,
    management,
    owners: createAppOwnerAgents(db),
    cards,
    recover: new AppRecoverOwnerActionCards(db),
    prepareRecover: (agentId: string, toAgent: string) =>
      cards.prepare(
        { workspaceId: ws.id, agentId },
        {
          target: `#${channel.channelName}`,
          action: { type: "app:recover_owner", clientKey: key, toAgent },
        },
      ),
    caller: (a: { id: string }) => ({ workspaceId: ws.id, agentId: a.id }),
    app: () => db.app.findUniqueOrThrow({ where: { key } }),
    archive: (a: { id: string }) =>
      db.agent.update({ where: { id: a.id }, data: { deletedAt: new Date() } }),
    cleanup: async () => {
      await db.app.deleteMany({ where: { ownerWorkspaceId: ws.id } });
      await ws.cleanup();
    },
  };
}
