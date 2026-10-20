import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { createAuthorizationEndpoint } from "#src/server/authorization-server/authorization-endpoint-composition.server";
import { createTokenEndpoints } from "#src/server/authorization-server/token-endpoint-composition.server";
import { basic, ISSUER, SIGNING_KEYS, VERIFIER } from "./oidc-token-fixture";

/**
 * The token and UserInfo endpoints over local PostgreSQL with migrations applied: a code the
 * authorization endpoint stored is redeemed once, and what UserInfo reads follows the person, the
 * Workspace and the consent as they are now.
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

const SECRET = "test-session-secret-at-least-32-characters";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT_URI = "http://localhost:9999/cb";
const NOW = new Date("2026-10-20T08:00:00.000Z");

/** A member of a Workspace whose app they approved; `code()` issues a fresh code for them. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: "Owner", username: `oidc-owner-${suffix}` },
  });
  const member = await db.user.create({
    data: {
      displayName: "Ada Lovelace",
      username: `oidc-ada-${suffix}`,
      email: "ada@acme.example",
      avatarObjectKey: "preset:portrait-07",
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `oidc-token-${suffix}`,
      name: "Acme",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "admin" },
        ],
      },
    },
  });
  const key = `acme-${suffix}`;
  const { clientSecret } = await createAppRegistry(db).registerApp(
    { workspaceId: workspace.id, actorUserId: owner.id },
    {
      key,
      name: "Acme Notes",
      description: "",
      whenToUse: "",
      homepageUrl: null,
      redirectUris: [REDIRECT_URI],
      category: "productivity",
      allowedScopes: ["openid", "profile", "identity", "email"],
    },
  );
  const authorization = createAuthorizationEndpoint({
    issuer: ISSUER,
    secret: SECRET,
    db,
    now: () => NOW,
  });
  const subject = { userId: member.id, authTime: NOW.getTime() / 1000 - 60 };
  /** A code the member approved for `scope`. */
  async function code(scope = "openid profile email identity"): Promise<string> {
    const begun = await authorization.begin(
      new URLSearchParams({
        client_id: key,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        prompt: "consent",
      }).toString(),
      subject,
    );
    if (begun.kind !== "page" || begun.page.view !== "consent") throw new Error("no consent page");
    const decided = await authorization.decide(begun.page.handle, subject, {
      approve: true,
      workspaceId: workspace.id,
    });
    if (decided.kind !== "redirect") throw new Error("no code");
    return new URL(decided.location).searchParams.get("code")!;
  }
  const { token, userInfo } = createTokenEndpoints({
    issuer: ISSUER,
    signingKeys: SIGNING_KEYS,
    db,
    now: () => NOW,
  });
  let secret = clientSecret;
  const exchange = (presented: string, presentedSecret = secret) =>
    token.exchange(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basic(key, presentedSecret),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: presented,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
        }).toString(),
      }),
    );
  const accessToken = async (presented: string) =>
    ((await (await exchange(presented)).json()) as { access_token: string }).access_token;
  const read = (accessToken: string) =>
    userInfo.answer(
      new Request(`${ISSUER}/me`, { headers: { authorization: `Bearer ${accessToken}` } }),
    );
  return {
    member,
    workspace,
    key,
    owner,
    /** Rotates the app's secret, as Settings → Applications does. */
    async rotate() {
      const old = secret;
      secret = (
        await createAppRegistry(db).rotateAppSecret(
          { workspaceId: workspace.id, actorUserId: owner.id },
          key,
        )
      ).clientSecret;
      return old;
    },
    code,
    exchange,
    accessToken,
    read,
    async cleanup() {
      await db.app.deleteMany({ where: { key } }).catch(() => {});
      await db.workspace.deleteMany({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } }).catch(() => {});
    },
  };
}

test.skipIf(!db)("an approved code redeems once, and UserInfo reads the person", async () => {
  const f = await fixture(db!);
  try {
    const code = await f.code();
    const response = await f.exchange(code);
    expect(response.status).toBe(200);
    const { access_token } = (await response.json()) as { access_token: string };
    expect(await (await f.read(access_token)).json()).toEqual({
      sub: f.member.id,
      name: "Ada Lovelace",
      preferred_username: f.member.username,
      picture: "https://coforge.example/avatars/portrait-07.webp",
      email: "ada@acme.example",
      email_verified: false,
      type: "user",
      workspace_id: f.workspace.id,
      workspace_slug: f.workspace.slug,
      workspace_role: "admin",
    });

    // The second redemption is refused and recorded; the first token stops working.
    expect((await f.exchange(code)).status).toBe(400);
    expect((await f.read(access_token)).status).toBe(401);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("two redemptions of one code at once yield one token answer", async () => {
  const f = await fixture(db!);
  try {
    const code = await f.code();
    const answers = await Promise.all([f.exchange(code), f.exchange(code)]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 400]);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "UserInfo follows the person: an uploaded avatar no app can fetch is left out, and leaving the Workspace or a revoked consent ends the token",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.accessToken(await f.code());
      await db!.user.update({
        where: { id: f.member.id },
        data: {
          displayName: "Ada King",
          email: null,
          avatarObjectKey: `users/${f.member.id}/avatars/a1/original`,
          avatarContentType: "image/png",
        },
      });
      await db!.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.member.id } },
        data: { role: "member" },
      });
      expect(await (await f.read(token)).json()).toEqual({
        sub: f.member.id,
        name: "Ada King",
        preferred_username: f.member.username,
        type: "user",
        workspace_id: f.workspace.id,
        workspace_slug: f.workspace.slug,
        workspace_role: "member",
      });

      await db!.userAppConsent.updateMany({
        where: { userId: f.member.id },
        data: { revokedAt: NOW },
      });
      expect((await f.read(token)).status).toBe(401);

      const fresh = await f.accessToken(await f.code());
      expect((await f.read(fresh)).status).toBe(200);
      await db!.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.member.id } },
      });
      expect((await f.read(fresh)).status).toBe(401);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a rotated secret stops authenticating the app at once", async () => {
  const f = await fixture(db!);
  try {
    const old = await f.rotate();
    const code = await f.code();
    expect((await f.exchange(code, old)).status).toBe(401);
    expect((await f.exchange(code)).status).toBe(200);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("narrowing the app's scopes narrows what an issued token releases", async () => {
  const f = await fixture(db!);
  try {
    const token = await f.accessToken(await f.code());
    await db!.app.update({
      where: { key: f.key },
      data: { allowedScopes: ["openid", "profile", "identity"] },
    });
    const claims = (await (await f.read(token)).json()) as Record<string, unknown>;
    expect(claims.workspace_role).toBe("admin");
    expect(claims.email).toBeUndefined();
    expect(claims.email_verified).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
