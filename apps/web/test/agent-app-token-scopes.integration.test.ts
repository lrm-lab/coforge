import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { jwtVerify } from "jose";

import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaAppAgentAccessStore } from "#src/server/db/repositories/app-agent-access.repositories.server";
import {
  fixture,
  jwks,
  refusal,
  revokeGrant,
  token,
  type Fixture,
} from "./agent-app-token-fixture";
import { ISSUER } from "./oidc-token-fixture";

/**
 * The scopes an Agent asks its app token for (`coforge app invoke` asks for an action's
 * `required_scopes`), against local PostgreSQL with migrations applied: a covered request is
 * narrowed to exactly what was asked, a missing scope waits for a person and widens the grant, and
 * a scope the app does not allow is refused.
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

const FIXED = ["openid", "profile", "identity"];
const WITH_EMAIL = [...FIXED, "email"];
const allowEmail = (f: Fixture) =>
  db!.app.update({ where: { id: f.app.id }, data: { allowedScopes: WITH_EMAIL } });
const grantedScopes = async (f: Fixture) =>
  (await f.access.list(f.as("owner"), f.agent.id)).grants[0]?.scopes;

test.skipIf(!db)("a covered request gets a token narrowed to exactly what was asked", async () => {
  const f = await fixture(db!);
  try {
    await allowEmail(f);
    await f.access.grant(f.as("owner"), {
      agentId: f.agent.id,
      appKey: f.app.key,
      scopes: ["email"],
    });
    // No scopes: the grant's, unchanged.
    expect((await token(f, f.app.key)).body.scope).toBe(WITH_EMAIL.join(" "));
    const narrowed = await token(f, f.app.key, { scopes: [] });
    expect(narrowed.body).toMatchObject({ status: "issued", scope: FIXED.join(" ") });
    const asked = await token(f, f.app.key, { scopes: ["email"] });
    expect(asked.body).toMatchObject({ status: "issued", scope: WITH_EMAIL.join(" ") });
    const { payload } = await jwtVerify(narrowed.body.access_token as string, jwks, {
      issuer: ISSUER,
      audience: f.app.key,
    });
    expect(payload.scope).toBe(FIXED.join(" "));
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a scope the grant lacks waits for approval, which widens the grant", async () => {
  const f = await fixture(db!);
  try {
    await allowEmail(f);
    expect((await token(f, f.app.key)).body.status).toBe("issued");
    expect(await grantedScopes(f)).toEqual(FIXED);

    const target = `#${f.hub.channelName}`;
    const waiting = await token(f, f.app.key, { scopes: ["email"], target });
    expect(waiting.body).toMatchObject({ status: "approval_required", scopes: WITH_EMAIL });
    const messageId = waiting.body.actionCardMessageId as string;
    const card = await db!.actionCard.findUniqueOrThrow({ where: { messageId } });
    expect(card.payload).toMatchObject({ scopes: WITH_EMAIL });

    await f.access.approve(f.as("owner"), {
      agentId: f.agent.id,
      requestId: waiting.body.requestId as string,
    });
    expect(await grantedScopes(f)).toEqual(WITH_EMAIL);
    const issued = await token(f, f.app.key, { scopes: ["email"] });
    expect(issued.body).toMatchObject({ status: "issued", scope: WITH_EMAIL.join(" ") });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a waiting request is extended with the scopes asked for later", async () => {
  const f = await fixture(db!);
  try {
    await allowEmail(f);
    await token(f, f.app.key);
    await revokeGrant(f);
    const target = `#${f.hub.channelName}`;
    const first = await token(f, f.app.key, { target });
    expect(first.body).toMatchObject({ status: "approval_required", scopes: FIXED });
    const publishedBefore = f.published.length;
    const second = await token(f, f.app.key, { scopes: ["email"] });
    // Browsers showing the card are told it changed.
    expect(f.published.slice(publishedBefore)).toContain(first.body.actionCardMessageId as string);
    expect(second.body).toMatchObject({
      status: "approval_required",
      requestId: first.body.requestId,
      scopes: WITH_EMAIL,
    });
    const card = await db!.actionCard.findUniqueOrThrow({
      where: { messageId: first.body.actionCardMessageId as string },
    });
    expect(card.payload).toMatchObject({ scopes: WITH_EMAIL });
    await f.access.approve(f.as("owner"), {
      agentId: f.agent.id,
      requestId: first.body.requestId as string,
    });
    expect(await grantedScopes(f)).toEqual(WITH_EMAIL);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a scope the app does not allow is INVALID_INPUT", async () => {
  const f = await fixture(db!);
  try {
    const refused = await token(f, f.app.key, { scopes: ["email"] });
    expect(refused).toEqual({
      status: 400,
      body: {
        ok: false,
        errorCode: "invalid_input",
        error: expect.stringContaining("scope email"),
      },
    });
    expect(await grantedScopes(f)).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an Agent outside the installation's selection still waits for a person",
  async () => {
    const f = await fixture(db!);
    try {
      await allowEmail(f);
      await db!.appInstallation.updateMany({
        where: { appId: f.app.id },
        data: { agentAccess: "selected" },
      });
      const waiting = await token(f, f.app.key, { scopes: ["email"] });
      expect(waiting.body).toMatchObject({ status: "approval_required", scopes: WITH_EMAIL });
      expect(await grantedScopes(f)).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a card approves only the scopes it showed; a widened request is a CONFLICT",
  async () => {
    const f = await fixture(db!);
    try {
      await allowEmail(f);
      await token(f, f.app.key);
      await revokeGrant(f);
      const first = await token(f, f.app.key, { target: `#${f.hub.channelName}` });
      const messageId = first.body.actionCardMessageId as string;
      await token(f, f.app.key, { scopes: ["email"] });

      // The card the person looked at showed only the fixed scopes.
      const stale = await refusal(f.grantCards.commit(f.as("owner"), messageId, f.access, FIXED));
      expect(stale).toMatchObject({ code: "CONFLICT", errorId: "app-grant-request-changed" });
      expect(await grantedScopes(f)).toBeUndefined();

      await f.grantCards.commit(f.as("owner"), messageId, f.access, WITH_EMAIL);
      expect(await grantedScopes(f)).toEqual(WITH_EMAIL);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("concurrent extensions of a request never drop a scope", async () => {
  const f = await fixture(db!);
  try {
    await token(f, f.app.key);
    await revokeGrant(f);
    const waiting = await token(f, f.app.key);
    const store = new PrismaAppAgentAccessStore(db!);
    const requestId = waiting.body.requestId as string;
    const results = await Promise.all([
      store.extendRequest({ requestId, scopes: ["email"] }),
      store.extendRequest({ requestId, scopes: FIXED }),
      store.extendRequest({ requestId, scopes: ["openid"] }),
    ]);
    for (const scopes of results) expect(scopes).toEqual(expect.arrayContaining(["openid"]));
    const row = await db!.appAgentAccessRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.scopes).toEqual(WITH_EMAIL);
    // A decided request is no longer extended.
    await f.access.deny(f.as("owner"), { agentId: f.agent.id, requestId });
    expect(await store.extendRequest({ requestId, scopes: ["email"] })).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
