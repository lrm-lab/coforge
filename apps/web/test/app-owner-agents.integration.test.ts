import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { hashAppClientSecret } from "#src/server/apps/app-client-secret.server";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { ActionCardError, ActionCards } from "#src/server/conversations/action-cards.server";
import { AppRegisterActionCards } from "#src/server/conversations/app-register-action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ISSUER, SIGNING_KEYS } from "./oidc-token-fixture";
import { credentialsRequest } from "./oidc-installation-token-fixture";

/**
 * An Agent registering an app through an `app:register` card and managing it afterwards, against
 * local PostgreSQL with migrations applied.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

afterAll(async () => {
  await db?.$disconnect();
});

type Notice = { agentId: string; appKey: string; appName: string; clientSecret: string };

/** A Workspace with an owner, an admin and a member; two Agents in a channel. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const person = (role: string) => ({
    displayName: `reg-${role}-${suffix}`,
    username: `reg-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug: `reg-${suffix}`,
      name: "Registrations",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  const agent = (name: string, role = "member") =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: people.member.id,
        role,
        runtimeConfig: {},
      },
    });
  const scout = await agent("scout");
  const other = await agent("other");
  const boss = await agent("boss", "admin");
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `reg-ch-${suffix}`,
      members: {
        create: [
          ...Object.values(people).map((user) => ({ userId: user.id })),
          ...[scout, other, boss].map((a) => ({ agentId: a.id })),
        ],
      },
    },
  });
  const notices: Notice[] = [];
  const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
    async memberChanged() {},
    async messageAvailable() {},
  });
  const register = new AppRegisterActionCards(db, undefined, {
    send: async (notice: Notice) => {
      notices.push(notice);
      return true;
    },
  });
  const prepare = (agentId: string, extra: Record<string, unknown> = {}) =>
    actionCards.prepare(
      { workspaceId: workspace.id, agentId },
      {
        target: `#${channel.channelName}`,
        action: {
          type: "app:register",
          name: "Acme Notes",
          clientKey: `acme-${suffix}`,
          redirectUrls: ["https://notes.acme.example/callback"],
          homepageUrl: "https://notes.acme.example/",
          description: "Notes for the team.",
          ...extra,
        },
      },
    );
  const actor = (role: keyof typeof people) => ({
    workspaceId: workspace.id,
    userId: people[role].id,
  });
  return {
    suffix,
    workspace,
    people,
    scout,
    other,
    boss,
    notices,
    prepare,
    register,
    actionCards,
    actor,
    key: `acme-${suffix}`,
    caller: (a: { id: string }) => ({ workspaceId: workspace.id, agentId: a.id }),
    async cleanup() {
      await db.app.deleteMany({ where: { ownerWorkspaceId: workspace.id } });
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: Object.values(people).map((u) => u.id) } } });
    },
  };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

test.skipIf(!db)("any Agent prepares a card that shows every field and no secret", async () => {
  const f = await fixture(db!);
  try {
    const { messageId } = await f.prepare(f.scout.id, {
      scopes: ["email"],
      category: "productivity",
    });
    const card = await db!.actionCard.findUniqueOrThrow({ where: { messageId } });
    expect(card).toMatchObject({ kind: "app:register", state: "pending" });
    expect(card.payload).toMatchObject({
      type: "app:register",
      key: f.key,
      name: "Acme Notes",
      redirectUris: ["https://notes.acme.example/callback"],
      category: "productivity",
      allowedScopes: ["openid", "profile", "identity", "email"],
    });
    expect(JSON.stringify(card.payload)).not.toContain("secret");
    const views = await f.actionCards.viewsFor(f.workspace.id, f.people.admin.id, [messageId]);
    expect(views.get(messageId)).toMatchObject({
      kind: "app:register",
      canCommit: true,
      app: { clientKey: f.key, name: "Acme Notes", homepageUrl: "https://notes.acme.example/" },
    });
    const member = await f.actionCards.viewsFor(f.workspace.id, f.people.member.id, [messageId]);
    expect(member.get(messageId)).toMatchObject({ canCommit: false });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a card the registry would refuse is refused when prepared", async () => {
  const f = await fixture(db!);
  try {
    const bad = await refusal(f.prepare(f.scout.id, { redirectUrls: ["http://evil.example/cb"] }));
    expect(bad).toBeInstanceOf(ActionCardError);
    expect(bad).toMatchObject({ code: "INVALID_ACTION", field: "--redirect-url" });
    const category = await refusal(f.prepare(f.scout.id, { category: "nonsense" }));
    expect(category).toMatchObject({ code: "INVALID_ACTION", field: "--category" });

    await f.register.commit(f.actor("admin"), (await f.prepare(f.scout.id)).messageId);
    const taken = await refusal(f.prepare(f.other.id));
    expect(taken).toMatchObject({ code: "APP_EXISTS", status: 409 });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an admin commits once: the app is made, the Agent owns it, and the secret goes only to the Agent",
  async () => {
    const f = await fixture(db!);
    try {
      const { messageId } = await f.prepare(f.scout.id);
      const { clientKey } = await f.register.commit(f.actor("admin"), messageId);
      expect(clientKey).toBe(f.key);

      const app = await db!.app.findUniqueOrThrow({
        where: { key: f.key },
        include: { installations: true },
      });
      expect(app).toMatchObject({
        ownerWorkspaceId: f.workspace.id,
        ownerAgentId: f.scout.id,
        createdByUserId: f.people.admin.id,
      });
      expect(app.installations.map((i) => i.workspaceId)).toEqual([f.workspace.id]);

      const card = await db!.actionCard.findUniqueOrThrow({ where: { messageId } });
      expect(card).toMatchObject({
        state: "executed",
        committedByUserId: f.people.admin.id,
        result: { clientKey: f.key },
      });

      expect(f.notices).toHaveLength(1);
      const [notice] = f.notices;
      expect(notice).toMatchObject({ agentId: f.scout.id, appKey: f.key, appName: "Acme Notes" });
      expect(app.clientSecretHash).toBe(hashAppClientSecret(notice!.clientSecret));
      // The secret is in no row of the card, its message or the conversation.
      const rows = JSON.stringify([
        card,
        await db!.message.findMany({ where: { conversationId: card.conversationId } }),
      ]);
      expect(rows).not.toContain(notice!.clientSecret);

      const again = await refusal(f.register.commit(f.actor("owner"), messageId));
      expect(isAppError(again) && (again as AppError).code).toBe("CONFLICT");
      expect(f.notices).toHaveLength(1);
      expect(await db!.app.count({ where: { ownerWorkspaceId: f.workspace.id } })).toBe(1);

      const view = (
        await f.actionCards.viewsFor(f.workspace.id, f.people.owner.id, [messageId])
      ).get(messageId);
      expect(view).toMatchObject({ state: "executed", result: { clientKey: f.key } });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a member cannot commit: nothing is registered and the card stays pending",
  async () => {
    const f = await fixture(db!);
    try {
      const { messageId } = await f.prepare(f.scout.id);
      const error = await refusal(f.register.commit(f.actor("member"), messageId));
      expect(isAppError(error) && (error as AppError).code).toBe("ACCESS_DENIED");
      expect(await db!.app.count({ where: { ownerWorkspaceId: f.workspace.id } })).toBe(0);
      expect((await db!.actionCard.findUniqueOrThrow({ where: { messageId } })).state).toBe(
        "pending",
      );
      expect(f.notices).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "status and list show the Agent's cards and apps, and an admin Agent sees them all",
  async () => {
    const f = await fixture(db!);
    try {
      const owners = createAppOwnerAgents(db!);
      const { messageId } = await f.prepare(f.scout.id);
      expect(await owners.status(f.caller(f.scout), { card: messageId })).toMatchObject({
        status: "card_pending",
        clientKey: f.key,
      });
      expect(await owners.status(f.caller(f.scout), { client: f.key })).toMatchObject({
        status: "card_pending",
        cardMessageId: messageId,
      });
      expect((await owners.list(f.caller(f.scout))).pending).toEqual([
        { cardMessageId: messageId, name: "Acme Notes", clientKey: f.key },
      ]);
      // Another Agent's card is not this Agent's to see.
      const hidden = await refusal(owners.status(f.caller(f.other), { card: messageId }));
      expect(isAppError(hidden) && (hidden as AppError).code).toBe("NOT_FOUND");

      await f.register.commit(f.actor("admin"), messageId);
      expect(await owners.status(f.caller(f.scout), { card: messageId })).toMatchObject({
        status: "committed",
        clientKey: f.key,
        committedBy: `reg-admin-${f.suffix}`,
      });
      expect(await owners.status(f.caller(f.scout), { client: f.key })).toEqual({
        status: "committed",
        clientKey: f.key,
      });
      expect(await owners.list(f.caller(f.scout))).toEqual({
        pending: [],
        apps: [{ clientKey: f.key, name: "Acme Notes", role: "owner" }],
      });
      expect((await owners.list(f.caller(f.other))).apps).toEqual([]);
      expect((await owners.list(f.caller(f.boss))).apps).toEqual([
        { clientKey: f.key, name: "Acme Notes", role: "admin" },
      ]);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "rotating gives a new secret, invalidates the old one, and is for the owner Agent or an admin Agent",
  async () => {
    const f = await fixture(db!);
    try {
      const owners = createAppOwnerAgents(db!);
      await f.register.commit(f.actor("admin"), (await f.prepare(f.scout.id)).messageId);
      const first = f.notices[0]!.clientSecret;
      const endpoints = createTokenEndpoints({
        issuer: ISSUER,
        signingKeys: SIGNING_KEYS,
        db: db!,
      });
      const status = async (secret: string) =>
        (
          await endpoints.token.exchange(
            credentialsRequest({ authorization: `Basic ${btoa(`${f.key}:${secret}`)}` }),
          )
        ).status;
      // The client authenticates (it is refused only for the missing resource), not as a bad client.
      expect(await status(first)).not.toBe(401);

      const rotated = await owners.rotateSecret(f.caller(f.scout), f.key);
      expect(rotated.clientKey).toBe(f.key);
      expect(rotated.clientSecret).not.toBe(first);
      expect(await status(first)).toBe(401);
      expect(await status(rotated.clientSecret)).not.toBe(401);
      const stored = await db!.app.findUniqueOrThrow({ where: { key: f.key } });
      expect(stored.clientSecretHash).toBe(hashAppClientSecret(rotated.clientSecret));
      expect(stored.secretRotatedAt).not.toBeNull();

      // Any other Agent is refused; an unknown key is not found.
      const notOwner = await refusal(owners.rotateSecret(f.caller(f.other), f.key));
      expect(isAppError(notOwner) && (notOwner as AppError).code).toBe("NOT_FOUND");
      // An admin-role Agent of the same Workspace may rotate too, as Raft's admin Agents may.
      const byAdmin = await owners.rotateSecret(f.caller(f.boss), f.key);
      expect(await status(byAdmin.clientSecret)).not.toBe(401);
      expect(await status(rotated.clientSecret)).toBe(401);
      const unknown = await refusal(owners.rotateSecret(f.caller(f.scout), "no-such-app"));
      expect(isAppError(unknown) && (unknown as AppError).code).toBe("NOT_FOUND");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("an archived owner Agent can neither rotate nor list", async () => {
  const f = await fixture(db!);
  try {
    const owners = createAppOwnerAgents(db!);
    await f.register.commit(f.actor("admin"), (await f.prepare(f.scout.id)).messageId);
    await db!.agent.update({ where: { id: f.scout.id }, data: { deletedAt: new Date() } });
    for (const call of [
      owners.rotateSecret(f.caller(f.scout), f.key),
      owners.list(f.caller(f.scout)),
      owners.status(f.caller(f.scout), { client: f.key }),
    ]) {
      const error = await refusal(call);
      expect(isAppError(error) && (error as AppError).code).toBe("NOT_FOUND");
    }
    // The app, and its Workspace's right to it, are untouched.
    expect(await db!.app.count({ where: { key: f.key } })).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an Agent archived before the commit does not become the owner and gets no notice",
  async () => {
    const f = await fixture(db!);
    try {
      const { messageId } = await f.prepare(f.scout.id);
      await db!.agent.update({ where: { id: f.scout.id }, data: { deletedAt: new Date() } });
      await f.register.commit(f.actor("admin"), messageId);
      expect((await db!.app.findUniqueOrThrow({ where: { key: f.key } })).ownerAgentId).toBeNull();
      expect(f.notices).toHaveLength(0);
      const view = (
        await f.actionCards.viewsFor(f.workspace.id, f.people.owner.id, [messageId])
      ).get(messageId);
      expect(view).toMatchObject({ result: { clientKey: f.key, noOwnerAgent: true } });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("Settings names the owner Agent only while it is live and public", async () => {
  const f = await fixture(db!);
  try {
    const owners = createAppOwnerAgents(db!);
    await f.register.commit(f.actor("admin"), (await f.prepare(f.scout.id)).messageId);
    expect(await owners.ownerNames(f.workspace.id)).toEqual(new Map([[f.key, "scout"]]));
    await db!.agent.update({ where: { id: f.scout.id }, data: { visibility: "private" } });
    expect((await owners.ownerNames(f.workspace.id)).size).toBe(0);
    await db!.agent.update({
      where: { id: f.scout.id },
      data: { visibility: "public", deletedAt: new Date() },
    });
    expect((await owners.ownerNames(f.workspace.id)).size).toBe(0);
  } finally {
    await f.cleanup();
  }
});
