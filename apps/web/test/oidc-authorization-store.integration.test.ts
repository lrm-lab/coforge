import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { hashAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import { createAuthorizationEndpoint } from "#src/server/authorization-server/authorization-endpoint-composition.server";

/**
 * The authorization endpoint over local PostgreSQL with migrations applied: which Workspaces are
 * offered, what a code is stored as, and how a consent is remembered and revoked.
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

const ISSUER = "https://coforge.example/oidc";
const SECRET = "test-session-secret-at-least-32-characters";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const NOW = new Date("2026-10-20T08:00:00.000Z");

/** Two Workspaces, the app registered in the first; `cleanup` removes all of it. */
async function fixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const person = (name: string) =>
    db.user.create({
      data: { displayName: `oidc-${name}-${suffix}`, username: `oidc-${name}-${suffix}` },
    });
  const owner = await person("owner");
  const member = await person("member");
  const outsider = await person("outsider");
  const home = await db.workspace.create({
    data: {
      slug: `oidc-home-${suffix}`,
      name: "Home",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const other = await db.workspace.create({
    data: {
      slug: `oidc-other-${suffix}`,
      name: "Other",
      members: {
        create: [
          { userId: outsider.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const key = `acme-${suffix}`;
  await createAppRegistry(db).registerApp(
    { workspaceId: home.id, actorUserId: owner.id },
    {
      key,
      name: "Acme Notes",
      description: "",
      whenToUse: "",
      homepageUrl: "https://notes.acme.example/",
      redirectUris: ["http://localhost:9999/cb"],
      category: "productivity",
      allowedScopes: ["openid", "profile", "identity", "email"],
    },
  );
  const app = await db.app.findUniqueOrThrow({ where: { key } });
  const search = (overrides: Record<string, string> = {}) =>
    new URLSearchParams({
      client_id: key,
      redirect_uri: "http://localhost:9999/cb",
      response_type: "code",
      scope: "openid profile",
      state: "s-1",
      nonce: "n-1",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      ...overrides,
    }).toString();
  return {
    app,
    home,
    other,
    member: { userId: member.id, authTime: NOW.getTime() / 1000 - 60 },
    outsider: { userId: outsider.id, authTime: NOW.getTime() / 1000 - 60 },
    search,
    async cleanup() {
      await db.workspace.deleteMany({ where: { id: { in: [home.id, other.id] } } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } })
        .catch(() => {});
    },
  };
}

const codeOf = (location: string) => new URL(location).searchParams.get("code");

/** The handle of the consent page `begin` shows the member. */
async function consentHandle(
  endpoint: ReturnType<typeof createAuthorizationEndpoint>,
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const outcome = await endpoint.begin(f.search(), f.member);
  if (outcome.kind !== "page" || outcome.page.view !== "consent")
    throw new Error("expected the consent page");
  return outcome.page.handle;
}

test.skipIf(!db)("only a member of a Workspace the app is installed in is offered it", async () => {
  const f = await fixture(db!);
  const endpoint = createAuthorizationEndpoint({
    issuer: ISSUER,
    secret: SECRET,
    db: db!,
    now: () => NOW,
  });
  try {
    expect(await endpoint.begin(f.search(), f.member)).toMatchObject({
      kind: "page",
      page: {
        view: "consent",
        workspaces: [{ id: f.home.id, slug: f.home.slug, name: "Home" }],
      },
    });
    expect(await endpoint.begin(f.search(), f.outsider)).toMatchObject({
      kind: "page",
      page: { view: "unavailable" },
    });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an approved request stores the code's hash with its bindings, and the consent then skips the page",
  async () => {
    const f = await fixture(db!);
    const endpoint = createAuthorizationEndpoint({
      issuer: ISSUER,
      secret: SECRET,
      db: db!,
      now: () => NOW,
    });
    try {
      const approved = await endpoint.decide(await consentHandle(endpoint, f), f.member, {
        approve: true,
        workspaceId: f.home.id,
      });
      if (approved.kind !== "redirect") throw new Error("expected a code");
      const code = codeOf(approved.location)!;
      const rows = await db!.oAuthAuthorizationCode.findMany({ where: { appId: f.app.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        codeHash: hashAuthorizationCode(code),
        userId: f.member.userId,
        workspaceId: f.home.id,
        redirectUri: "http://localhost:9999/cb",
        codeChallenge: CHALLENGE,
        nonce: "n-1",
        scopes: ["openid", "profile"],
        authTime: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 600_000),
        consumedAt: null,
        replayedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain(code);

      const again = await endpoint.begin(f.search(), f.member);
      if (again.kind !== "redirect") throw new Error("expected the page to be skipped");
      expect(codeOf(again.location)).not.toBe(code);
      expect(await endpoint.begin(f.search({ scope: "openid email" }), f.member)).toMatchObject({
        kind: "page",
        page: { view: "consent" },
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a revoked consent covers nothing until the person approves again", async () => {
  const f = await fixture(db!);
  const endpoint = createAuthorizationEndpoint({
    issuer: ISSUER,
    secret: SECRET,
    db: db!,
    now: () => NOW,
  });
  const approve = async () =>
    endpoint.decide(await consentHandle(endpoint, f), f.member, {
      approve: true,
      workspaceId: f.home.id,
    });
  try {
    await approve();
    await db!.userAppConsent.updateMany({
      where: { appId: f.app.id },
      data: { revokedAt: NOW },
    });
    expect(await endpoint.begin(f.search(), f.member)).toMatchObject({ kind: "page" });

    await approve();
    const consents = await db!.userAppConsent.findMany({ where: { appId: f.app.id } });
    expect(consents).toMatchObject([
      {
        userId: f.member.userId,
        workspaceId: f.home.id,
        scopes: ["openid", "profile"],
        revokedAt: null,
      },
    ]);
    expect((await endpoint.begin(f.search(), f.member)).kind).toBe("redirect");
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "the same answer sent twice records one consent and two codes, without an error",
  async () => {
    const f = await fixture(db!);
    const endpoint = createAuthorizationEndpoint({
      issuer: ISSUER,
      secret: SECRET,
      db: db!,
      now: () => NOW,
    });
    try {
      const handle = await consentHandle(endpoint, f);
      const answers = await Promise.all(
        [1, 2].map(() =>
          endpoint.decide(handle, f.member, { approve: true, workspaceId: f.home.id }),
        ),
      );
      expect(answers.map((answer) => answer.kind)).toEqual(["redirect", "redirect"]);
      expect(await db!.userAppConsent.count({ where: { appId: f.app.id } })).toBe(1);
      expect(await db!.oAuthAuthorizationCode.count({ where: { appId: f.app.id } })).toBe(2);
    } finally {
      await f.cleanup();
    }
  },
);
