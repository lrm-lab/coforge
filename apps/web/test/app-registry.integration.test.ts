import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { hashAppClientSecret } from "#src/server/apps/app-client-secret.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { AppRegistry } from "#src/server/apps/app-registry.server";
import { PrismaAppRegistryStore } from "#src/server/db/repositories/app.repositories.server";

/**
 * The app registry against local PostgreSQL with migrations applied: what registering, listing,
 * changing, rotating and deleting an app store.
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

/** A Workspace with an owner, an admin and a member; `cleanup` removes all of it. */
async function workspaceFixture(db: PrismaClient) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const person = (role: string) => ({
    displayName: `apps-${role}-${suffix}`,
    username: `apps-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug: `apps-${suffix}`,
      name: "Apps",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  return {
    suffix,
    workspace,
    /** The Workspace's member of that role, acting in it. */
    actor: (role: keyof typeof people) => ({
      workspaceId: workspace.id,
      actorUserId: people[role].id,
    }),
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

const registration = (key: string): AppRegistrationInput => ({
  key,
  name: "Acme Notes",
  description: "Notes for the team.",
  whenToUse: "Read or write the team's notes.",
  homepageUrl: "https://notes.acme.example/",
  redirectUris: ["https://notes.acme.example/oauth/callback"],
  category: "productivity",
  allowedScopes: ["openid", "profile", "identity"],
});

test.skipIf(!db)(
  "a registered app's client secret is returned once and only its hash is stored",
  async () => {
    const fixture = await workspaceFixture(db!);
    const registry = createAppRegistry(db!);
    const key = `acme-${fixture.suffix}`;
    try {
      const { app, clientSecret } = await registry.registerApp(
        fixture.actor("admin"),
        registration(key),
      );
      expect(clientSecret).toMatch(/^cfa_secret_[A-Za-z0-9_-]{43}$/);
      expect(app).toMatchObject({ key, ownerWorkspaceId: fixture.workspace.id });
      expect(Object.keys(app)).not.toContain("clientSecretHash");

      const stored = await db!.app.findUniqueOrThrow({ where: { key } });
      expect(stored.clientSecretHash).toBe(hashAppClientSecret(clientSecret));
      expect(JSON.stringify(stored)).not.toContain(clientSecret);
      expect(stored.createdByUserId).toBe(fixture.actor("admin").actorUserId);
      expect(
        await db!.appInstallation.findMany({
          where: { appId: stored.id },
          select: { workspaceId: true, installedByUserId: true },
        }),
      ).toEqual([
        {
          workspaceId: fixture.workspace.id,
          installedByUserId: fixture.actor("admin").actorUserId,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)("rotating a secret retires the old one", async () => {
  const fixture = await workspaceFixture(db!);
  const registry = createAppRegistry(db!);
  const key = `acme-${fixture.suffix}`;
  try {
    const { clientSecret: first } = await registry.registerApp(
      fixture.actor("owner"),
      registration(key),
    );
    const rotated = await registry.rotateAppSecret(fixture.actor("owner"), key);
    expect(rotated.clientSecret).not.toBe(first);
    expect(rotated.app.secretRotatedAt).toBeInstanceOf(Date);
    // Only the new secret's hash is stored; the token endpoint authenticates against it.
    const stored = await db!.app.findUniqueOrThrow({
      where: { key },
      select: { clientSecretHash: true },
    });
    expect(stored.clientSecretHash).toBe(hashAppClientSecret(rotated.clientSecret));
    expect(stored.clientSecretHash).not.toBe(hashAppClientSecret(first));
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)(
  "a change sets only the fields it names, as checked, and never the key",
  async () => {
    const fixture = await workspaceFixture(db!);
    const registry = createAppRegistry(db!);
    const actor = fixture.actor("admin");
    const key = `acme-${fixture.suffix}`;
    try {
      await registry.registerApp(actor, registration(key));
      const changed = await registry.updateApp(actor, key, {
        name: " Acme Notes 2 ",
        category: "developer-tools",
        redirectUris: ["http://127.0.0.1:8080/cb"],
        // An untyped caller's extra fields reach nothing.
        ...({ key: "renamed", ownerWorkspaceId: null, clientSecretHash: "x" } as object),
      });
      expect(changed).toMatchObject({
        key,
        ownerWorkspaceId: fixture.workspace.id,
        name: "Acme Notes 2",
        description: "Notes for the team.",
        category: "developer-tools",
        redirectUris: ["http://127.0.0.1:8080/cb"],
      });
      await expect(
        registry.updateApp(actor, key, { homepageUrl: "http://x" }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        errorId: "app-homepage-url-invalid",
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!db)("an app may have no homepage, and a change can add or remove it", async () => {
  const fixture = await workspaceFixture(db!);
  const registry = createAppRegistry(db!);
  const actor = fixture.actor("owner");
  const key = `bare-${fixture.suffix}`;
  try {
    const { app } = await registry.registerApp(actor, { ...registration(key), homepageUrl: null });
    expect(app.homepageUrl).toBeNull();
    expect((await db!.app.findUniqueOrThrow({ where: { key } })).homepageUrl).toBeNull();

    const added = await registry.updateApp(actor, key, {
      homepageUrl: "https://bare.acme.example/",
    });
    expect(added.homepageUrl).toBe("https://bare.acme.example/");
    const removed = await registry.updateApp(actor, key, { homepageUrl: null });
    expect(removed.homepageUrl).toBeNull();
  } finally {
    await fixture.cleanup();
  }
});

test.skipIf(!db)(
  "a Workspace lists the apps it registered, never another Workspace's, a built-in one or a secret",
  async () => {
    const mine = await workspaceFixture(db!);
    const theirs = await workspaceFixture(db!);
    const registry = createAppRegistry(db!);
    const mineKey = `mine-${mine.suffix}`;
    try {
      await registry.registerApp(mine.actor("owner"), registration(mineKey));
      await registry.registerApp(theirs.actor("owner"), registration(`theirs-${theirs.suffix}`));

      const listed = await registry.listWorkspaceApps(mine.actor("member"));
      expect(listed.map(({ key, ownerWorkspaceId }) => [key, ownerWorkspaceId])).toEqual([
        [mineKey, mine.workspace.id],
      ]);
      for (const app of listed) expect(Object.keys(app)).not.toContain("clientSecretHash");

      // Someone outside the Workspace lists nothing.
      await expect(
        registry.listWorkspaceApps({
          workspaceId: mine.workspace.id,
          actorUserId: theirs.actor("member").actorUserId,
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  },
);

test.skipIf(!db)("a key is taken once, across every Workspace", async () => {
  const mine = await workspaceFixture(db!);
  const theirs = await workspaceFixture(db!);
  const registry = createAppRegistry(db!);
  const key = `acme-${mine.suffix}`;
  try {
    await registry.registerApp(mine.actor("owner"), registration(key));
    await expect(
      registry.registerApp(theirs.actor("owner"), registration(key)),
    ).rejects.toMatchObject({ code: "CONFLICT", errorId: "app-key-taken" });
    expect(await db!.app.count({ where: { ownerWorkspaceId: theirs.workspace.id } })).toBe(0);
  } finally {
    await mine.cleanup();
    await theirs.cleanup();
  }
});

test.skipIf(!db)(
  "a Workspace deletes its own app, but not another Workspace's, and finds no built-in one to change",
  async () => {
    const mine = await workspaceFixture(db!);
    const theirs = await workspaceFixture(db!);
    const registry = createAppRegistry(db!);
    const actor = mine.actor("admin");
    const mineKey = `mine-${mine.suffix}`;
    const theirsKey = `theirs-${theirs.suffix}`;
    try {
      await registry.registerApp(actor, registration(mineKey));
      const theirsApp = await registry.registerApp(theirs.actor("owner"), registration(theirsKey));

      for (const attempt of [
        () => registry.deleteApp(actor, theirsKey),
        () => registry.updateApp(actor, theirsKey, { name: "Taken over" }),
        () => registry.rotateAppSecret(actor, theirsKey),
      ])
        await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        (
          await db!.app.findUniqueOrThrow({
            where: { key: theirsKey },
            select: { clientSecretHash: true },
          })
        ).clientSecretHash,
      ).toBe(hashAppClientSecret(theirsApp.clientSecret));

      for (const builtIn of ["system.cleaner", "system.reminder"])
        for (const attempt of [
          () => registry.deleteApp(actor, builtIn),
          () => registry.updateApp(actor, builtIn, { name: "Renamed" }),
          () => registry.rotateAppSecret(actor, builtIn),
        ])
          await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });

      await registry.deleteApp(actor, mineKey);
      expect(await db!.app.findUnique({ where: { key: mineKey } })).toBeNull();
      await expect(registry.deleteApp(actor, mineKey)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an app registered without a key gets one made from its name, past a key already taken",
  async () => {
    const fixture = await workspaceFixture(db!);
    const actor = fixture.actor("owner");
    // A suffix made of the fixture's own, so runs never collide with each other.
    const taken = `t${fixture.suffix}`;
    const fresh = `f${fixture.suffix}`;
    const suffixes = [taken, fresh];
    const registry = new AppRegistry(new PrismaAppRegistryStore(db!), undefined, () =>
      suffixes.shift()!,
    );
    try {
      await registry.registerApp(actor, registration(`acme-notes-${taken}`));
      const { app } = await registry.registerApp(actor, {
        ...registration(""),
        name: "Acme Notes",
      });
      expect(app).toMatchObject({ key: `acme-notes-${fresh}`, category: "productivity" });
      expect((await db!.app.findUniqueOrThrow({ where: { key: app.key } })).allowedScopes).toEqual([
        "openid",
        "profile",
        "identity",
      ]);
    } finally {
      await fixture.cleanup();
    }
  },
);
