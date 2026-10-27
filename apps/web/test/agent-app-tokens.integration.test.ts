import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { jwtVerify } from "jose";
import { BUILT_IN_APPS } from "@lrm/coforge-sdk/internal";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { handleAgentAppToken } from "#src/routes/api/agent/v1/apps/$appId/token";
import { AppGrantCards } from "#src/server/conversations/app-grant-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  fixture,
  jwks,
  list,
  refusal,
  revokeGrant,
  token,
  type Fixture,
} from "./agent-app-token-fixture";
import { ISSUER } from "./oidc-token-fixture";

/**
 * An Agent using its Workspace's apps over the Agent HTTPS routes, against local PostgreSQL with
 * migrations applied: listing them with its access to each, getting a short-lived token, and the
 * approval card a person commits (approve) or cancels (deny) when the Agent needs approval.
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

test.skipIf(!db)(
  "an Agent lists its Workspace's apps with its access to each, and the built-in apps",
  async () => {
    const f = await fixture(db!);
    try {
      const { apps } = await list(f);
      expect(apps.filter((app) => !app.builtIn)).toEqual([
        {
          key: f.app.key,
          name: "Acme Notes",
          description: "Notes for the team.",
          whenToUse: "Read or write the team's notes.",
          homepageUrl: "https://notes.acme.example/",
          agentManifestUrl: "https://notes.acme.example/.well-known/coforge-agent-manifest.json",
          agentManifestUrlSource: "well_known",
          builtIn: false,
          access: "automatic",
        },
      ]);
      expect(apps.filter((app) => app.builtIn).map((app) => app.key)).toEqual(
        BUILT_IN_APPS.map((app) => app.key),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "the first use grants the app and answers a five-minute token for it; later uses are granted",
  async () => {
    const f = await fixture(db!);
    try {
      const first = await token(f, f.app.key);
      expect(first).toMatchObject({
        status: 200,
        body: {
          ok: true,
          status: "issued",
          token_type: "Bearer",
          expires_in: 300,
          audience: f.app.key,
          scope: "openid profile identity",
        },
      });
      const { payload } = await jwtVerify(first.body.access_token as string, jwks, {
        issuer: ISSUER,
        audience: f.app.key,
        typ: "at+jwt",
      });
      expect(payload).toMatchObject({
        sub: f.agent.id,
        client_id: f.app.key,
        type: "agent",
        workspace_id: f.workspace.id,
        workspace_slug: f.workspace.slug,
        scope: "openid profile identity",
      });
      expect((await list(f)).apps.find((app) => app.key === f.app.key)?.access).toBe("granted");
      expect((await token(f, f.app.key)).body.status).toBe("issued");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "after a revoke the Agent waits for approval; without a target nothing is posted",
  async () => {
    const f = await fixture(db!);
    try {
      await token(f, f.app.key);
      await revokeGrant(f);
      expect((await list(f)).apps.find((app) => app.key === f.app.key)?.access).toBe(
        "needs_approval",
      );

      const waiting = await token(f, f.app.key);
      expect(waiting).toEqual({
        status: 200,
        body: {
          ok: true,
          status: "approval_required",
          requestId: expect.any(String),
          scopes: ["openid", "profile", "identity"],
        },
      });
      expect((await list(f)).apps.find((app) => app.key === f.app.key)?.access).toBe(
        "pending_approval",
      );
      expect(await db!.actionCard.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "with a target the approval card is posted once per pending request, and committing it approves",
  async () => {
    const f = await fixture(db!);
    try {
      await token(f, f.app.key);
      await revokeGrant(f);
      const target = `#${f.hub.channelName}`;
      const [first, second] = await Promise.all([
        token(f, f.app.key, { target }),
        token(f, f.app.key, { target }),
      ]);
      // Read before matching: an asymmetric matcher in toMatchObject is written into the object.
      const messageId = first.body.actionCardMessageId as string;
      expect(typeof messageId).toBe("string");
      expect(first.body).toEqual({
        ok: true,
        status: "approval_required",
        requestId: first.body.requestId,
        scopes: ["openid", "profile", "identity"],
        actionCardMessageId: messageId,
      });
      expect(second.body).toEqual(first.body);
      // A later run without a target still learns the card that waits.
      expect((await token(f, f.app.key)).body).toEqual(first.body);
      const card = await db!.actionCard.findUniqueOrThrow({ where: { messageId } });
      expect(card).toMatchObject({
        kind: "app:grant_agent",
        conversationId: f.hub.id,
        preparedByAgentId: f.agent.id,
        state: "pending",
        payload: {
          type: "app:grant_agent",
          requestId: first.body.requestId,
          agentId: f.agent.id,
          appKey: f.app.key,
          appName: "Acme Notes",
          scopes: ["openid", "profile", "identity"],
        },
      });
      expect(await db!.actionCard.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      expect(f.published).toEqual([messageId]);

      const memberView = await f.cards.viewsFor(f.workspace.id, f.as("member").userId, [messageId]);
      expect(memberView.get(messageId)).toMatchObject({
        kind: "app:grant_agent",
        app: { key: f.app.key, name: "Acme Notes" },
        scopes: ["openid", "profile", "identity"],
        canCommit: false,
        canCancel: false,
      });
      const creatorView = await f.cards.viewsFor(f.workspace.id, f.as("creator").userId, [
        messageId,
      ]);
      expect(creatorView.get(messageId)).toMatchObject({ canCommit: true, canCancel: true });

      expect(
        isAppErrorCode(
          await refusal(f.grantCards.commit(f.as("member"), messageId, f.access)),
          "ACCESS_DENIED",
        ),
      ).toBe(true);
      await f.grantCards.commit(f.as("creator"), messageId, f.access);
      expect(await db!.actionCard.findUniqueOrThrow({ where: { messageId } })).toMatchObject({
        state: "executed",
        result: { requestId: first.body.requestId },
      });
      // Browsers refresh the card, and the Agent's Apps tab shows the decision.
      expect(f.published).toEqual([messageId, messageId]);
      expect(await f.access.list(f.as("owner"), f.agent.id)).toMatchObject({
        pendingRequests: [],
        grants: [expect.objectContaining({ appKey: f.app.key, source: "approval" })],
      });
      expect((await token(f, f.app.key)).body.status).toBe("issued");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "cancelling the approval card denies the request; the next use asks again",
  async () => {
    const f = await fixture(db!);
    try {
      await token(f, f.app.key);
      await revokeGrant(f);
      const waiting = await token(f, f.app.key, { target: `#${f.hub.channelName}` });
      const messageId = waiting.body.actionCardMessageId as string;

      expect(
        isAppErrorCode(
          await refusal(f.grantCards.deny(f.as("member"), messageId, f.access)),
          "ACCESS_DENIED",
        ),
      ).toBe(true);
      // The generic cancel would leave the request waiting with no card: it is refused.
      const adminActor = { workspaceId: f.workspace.id, actorUserId: f.as("admin").userId };
      expect(
        isAppErrorCode(await refusal(f.cards.cancel(adminActor, messageId)), "INVALID_INPUT"),
      ).toBe(true);
      await f.grantCards.deny(f.as("admin"), messageId, f.access);
      expect(await db!.actionCard.findUniqueOrThrow({ where: { messageId } })).toMatchObject({
        state: "cancelled",
      });
      const request = await db!.appAgentAccessRequest.findUniqueOrThrow({
        where: { id: waiting.body.requestId as string },
      });
      expect(request.status).toBe("denied");

      const again = await token(f, f.app.key);
      expect(again.body).toMatchObject({ status: "approval_required" });
      expect(again.body.requestId).not.toBe(waiting.body.requestId);
      expect(again.body.actionCardMessageId).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an app that is not installed in the Agent's Workspace, or a built-in one, has no token",
  async () => {
    const f = await fixture(db!);
    try {
      for (const key of [f.otherApp.key, "no-such-app", BUILT_IN_APPS[0].key])
        expect(await token(f, key)).toEqual({
          status: 200,
          body: { ok: true, status: "not_installed" },
        });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "with no authorization server there is no token, and the use grants nothing",
  async () => {
    const f = await fixture(db!);
    try {
      f.disableIssuer();
      expect(await token(f, f.app.key)).toEqual({
        status: 503,
        body: {
          ok: false,
          errorCode: "app_tokens_unavailable",
          error: expect.stringContaining("Login with CoForge"),
        },
      });
      expect((await list(f)).apps.find((app) => app.key === f.app.key)?.access).toBe("automatic");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a body with more than a target, or a target the Agent cannot post to, is refused",
  async () => {
    const f = await fixture(db!);
    try {
      const response = await handleAgentAppToken(
        new Request("https://server.example/", {
          method: "POST",
          body: JSON.stringify({ target: "#ops", scope: "email" }),
        }),
        f.principal,
        f.app.key,
        f.use(),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, errorCode: "request_invalid" });

      await token(f, f.app.key);
      await revokeGrant(f);
      const refused = await token(f, f.app.key, { target: `#${f.outside.channelName}` });
      expect(refused).toMatchObject({
        status: 422,
        body: { ok: false, errorCode: "target_invalid" },
      });
      expect(await db!.actionCard.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
);

/** A waiting request with its approval card posted to the hub: the request id and the card. */
async function waitingWithCard(f: Fixture) {
  await token(f, f.app.key);
  await revokeGrant(f);
  const { body } = await token(f, f.app.key, { target: `#${f.hub.channelName}` });
  return { requestId: body.requestId as string, messageId: body.actionCardMessageId as string };
}

const cardOf = (messageId: string) => db!.actionCard.findUniqueOrThrow({ where: { messageId } });

test.skipIf(!db)(
  "a request decided in the Agent's Apps tab settles its card: approved is executed, denied cancelled",
  async () => {
    const f = await fixture(db!);
    try {
      const approved = await waitingWithCard(f);
      await f.access.approve(f.as("admin"), { agentId: f.agent.id, requestId: approved.requestId });
      expect(await cardOf(approved.messageId)).toMatchObject({
        state: "executed",
        committedByUserId: f.as("admin").userId,
        result: { requestId: approved.requestId },
      });
      expect(f.published.at(-1)).toBe(approved.messageId);

      const denied = await waitingWithCard(f);
      expect(denied.messageId).not.toBe(approved.messageId);
      await f.access.deny(f.as("creator"), { agentId: f.agent.id, requestId: denied.requestId });
      expect(await cardOf(denied.messageId)).toMatchObject({ state: "cancelled" });
      expect(f.published.at(-1)).toBe(denied.messageId);
      // The card's own buttons now refuse: the request was decided.
      expect(
        isAppErrorCode(
          await refusal(f.grantCards.commit(f.as("owner"), denied.messageId, f.access)),
          "CONFLICT",
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a person granting the app approves the waiting request and settles its card",
  async () => {
    const f = await fixture(db!);
    try {
      const waiting = await waitingWithCard(f);
      await f.access.grant(f.as("owner"), { agentId: f.agent.id, appKey: f.app.key, scopes: [] });
      expect(await cardOf(waiting.messageId)).toMatchObject({
        state: "executed",
        committedByUserId: f.as("owner").userId,
      });
      expect(f.published.at(-1)).toBe(waiting.messageId);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a card is never posted for a request a person decided before it was posted",
  async () => {
    const f = await fixture(db!);
    try {
      await token(f, f.app.key);
      await revokeGrant(f);
      const waiting = await token(f, f.app.key);
      const requestId = waiting.body.requestId as string;
      await f.access.approve(f.as("owner"), { agentId: f.agent.id, requestId });

      const cards = new AppGrantCards(
        db!,
        new PrismaDirectConversationRepository(db!),
        () => undefined,
      );
      const posted = await cards.post(f.principal, `#${f.hub.channelName}`, {
        id: requestId,
        appKey: f.app.key,
        appName: "Acme Notes",
        scopes: ["openid", "profile", "identity"],
      });
      expect(posted).toBeUndefined();
      expect(await db!.actionCard.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a token carries only the grant's scopes the app still allows", async () => {
  const f = await fixture(db!);
  try {
    const allow = (allowedScopes: string[]) =>
      db!.app.update({ where: { id: f.app.id }, data: { allowedScopes } });
    await allow(["openid", "profile", "identity", "email"]);
    await f.access.grant(f.as("owner"), {
      agentId: f.agent.id,
      appKey: f.app.key,
      scopes: ["email"],
    });
    expect((await token(f, f.app.key)).body.scope).toBe("openid profile identity email");

    await allow(["openid", "profile", "identity"]);
    const narrowed = await token(f, f.app.key);
    expect(narrowed.body).toMatchObject({ status: "issued", scope: "openid profile identity" });
    const { payload } = await jwtVerify(narrowed.body.access_token as string, jwks, {
      issuer: ISSUER,
      audience: f.app.key,
    });
    expect(payload.scope).toBe("openid profile identity");
  } finally {
    await f.cleanup();
  }
});
