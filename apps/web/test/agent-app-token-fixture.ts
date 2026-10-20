import { expect } from "bun:test";
import { createLocalJWKSet, type JWK } from "jose";

import type { PrismaClient } from "#src/generated/prisma/client";
import { handleAgentAppList } from "#src/routes/api/agent/v1/apps/index";
import { handleAgentAppToken } from "#src/routes/api/agent/v1/apps/$appId/token";
import {
  createAgentAppUse,
  createAppAgentAccess,
} from "#src/server/app-agent-access/app-agent-access-composition.server";
import type { AuthorizationServerConfiguration } from "#src/server/authorization-server/configuration.server";
import { publicJwks } from "#src/server/authorization-server/signing-keys.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ISSUER, SIGNING_KEYS } from "./oidc-token-fixture";

/** A Workspace whose Agent uses an installed app over the Agent routes, and the calls its tests
 * share (`agent-app-tokens.integration.test.ts`). */

const READY: AuthorizationServerConfiguration = {
  status: "ready",
  issuer: ISSUER,
  signingKeys: SIGNING_KEYS,
};
export const jwks = createLocalJWKSet(publicJwks(SIGNING_KEYS) as { keys: JWK[] });
const PEOPLE = ["owner", "admin", "member", "creator"] as const;
type Person = (typeof PEOPLE)[number];

/** A Workspace with an owner, an admin and two members, one of whom created its Agent; a channel
 * the Agent is in and one it is not; an app installed in it and one installed only elsewhere. */
export async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const people = {} as Record<Person, { id: string }>;
  for (const role of PEOPLE)
    people[role] = await db.user.create({
      data: { displayName: `tok-${role}-${suffix}`, username: `tok-${role}-${suffix}` },
    });
  const workspace = await db.workspace.create({
    data: {
      slug: `tok-${suffix}`,
      name: "Tokens",
      members: {
        create: PEOPLE.map((role) => ({
          userId: people[role].id,
          role: role === "creator" ? "member" : role,
        })),
      },
    },
  });
  const elsewhere = await db.workspace.create({
    data: { slug: `tok-else-${suffix}`, name: "Elsewhere" },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `helper-${suffix}`,
      displayName: "Helper",
      ownerId: people.creator.id,
      runtimeConfig: {},
    },
  });
  const channel = (name: string, withAgent: boolean) =>
    db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `${name}-${suffix}`,
        members: {
          create: [
            ...PEOPLE.map((role) => ({ userId: people[role].id })),
            ...(withAgent ? [{ agentId: agent.id }] : []),
          ],
        },
      },
    });
  const app = (key: string, workspaceId: string) =>
    db.app.create({
      data: {
        key: `${key}-${suffix}`,
        ownerWorkspaceId: workspaceId,
        name: key === "notes" ? "Acme Notes" : "Other App",
        description: "Notes for the team.",
        whenToUse: "Read or write the team's notes.",
        homepageUrl: "https://notes.acme.example/",
        redirectUris: [],
        allowedScopes: ["openid", "profile", "identity"],
        clientSecretHash: "0".repeat(64),
        installations: { create: { workspaceId } },
      },
    });
  const published: string[] = [];
  const realtime: ConversationRealtime = {
    async memberChanged() {},
    async messageAvailable(event: { messageId: string }) {
      published.push(event.messageId);
    },
  };
  let issuer = READY;
  return {
    workspace,
    agent,
    hub: await channel("hub", true),
    outside: await channel("outside", false),
    app: await app("notes", workspace.id),
    otherApp: await app("other", elsewhere.id),
    published,
    principal: { workspaceId: workspace.id, agentId: agent.id },
    use: () =>
      createAgentAppUse(db, {
        issuer: () => issuer,
        realtime: () => realtime,
      }),
    disableIssuer() {
      issuer = { status: "disabled" };
    },
    access: createAppAgentAccess(db, { realtime: () => realtime }),
    cards: new ActionCards(db, undefined, realtime),
    as: (role: Person) => ({ workspaceId: workspace.id, userId: people[role].id }),
    async cleanup() {
      for (const id of [workspace.id, elsewhere.id])
        await db.workspace.delete({ where: { id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: PEOPLE.map((role) => people[role].id) } } })
        .catch(() => {});
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function list(f: Fixture) {
  const response = await handleAgentAppList(f.principal, f.use());
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: true; apps: Record<string, unknown>[] };
}

export async function token(f: Fixture, appKey: string, body: Record<string, unknown> = {}) {
  const response = await handleAgentAppToken(
    new Request(`https://server.example/api/agent/v1/apps/${appKey}/token`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    f.principal,
    appKey,
    f.use(),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function refusal(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Revokes the Agent's grant for the app, as a person in Settings would. */
export async function revokeGrant(f: Fixture) {
  const { grants } = await f.access.list(f.as("owner"), f.agent.id);
  await f.access.revoke(f.as("owner"), { agentId: f.agent.id, grantId: grants[0]!.id });
}
