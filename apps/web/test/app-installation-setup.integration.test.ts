import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { createAppEditorSave } from "#src/server/app-permissions/app-permissions-composition.server";
import { createAppInstallationSetup } from "#src/server/app-installation-setup/app-installation-setup-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * An app's installation setup against local PostgreSQL with migrations applied: the page it
 * declares, when its revision moves, what an installation reports, and that none of it is reachable
 * while `app-installation-setup` is off for the Workspace.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 16 }, (_, index) => `setup-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-setup-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        // The editor's Save also asks this flag; it stays off here.
        "app-data-permissions": {
          state: "DISABLED",
          variants: { off: false },
          defaultVariant: "off",
        },
        "app-installation-setup": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
          targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
});

afterAll(async () => {
  await installFeatureFlags({ status: "disabled" });
  if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
  await db?.$disconnect();
});

const PAGE = "https://acme.example/setup";
const OTHER_PAGE = "https://acme.example/connect";

/** A Workspace with an owner, an admin and a member, its app registered by the owner, and the flag
 * on for it unless `flag` is `off`. */
async function fixture(db: PrismaClient, { flag = "on" }: { flag?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = flag === "on" ? ON_SLUGS[nextOnSlug++]! : `setup-off-${suffix}`;
  const person = (role: string) => ({
    displayName: `setup-${role}-${suffix}`,
    username: `setup-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    admin: await db.user.create({ data: person("admin") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Setup",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  const actor = (role: keyof typeof people) => ({
    workspaceId: workspace.id,
    actorUserId: people[role].id,
  });
  const key = `setup-${suffix}`;
  const registration: AppRegistrationInput = {
    key,
    name: "Acme Insights",
    description: "",
    whenToUse: "",
    homepageUrl: null,
    redirectUris: [],
    category: "data-analytics",
    allowedScopes: ["openid", "profile", "identity"],
  };
  await createAppRegistry(db).registerApp(actor("owner"), registration);
  const setup = createAppInstallationSetup(db);
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id, app: { key } },
    select: { id: true },
  });
  return {
    key,
    people,
    actor,
    setup,
    workspaceId: workspace.id,
    installationId: installation.id,
    declare: (input: { url: string | null; description: string }) =>
      setup.declare(actor("owner"), key, input),
    async stored() {
      const app = await db.app.findUniqueOrThrow({
        where: { key },
        select: {
          setupUrl: true,
          setupDescription: true,
          setupRevision: true,
          name: true,
          installations: { select: { setupCompletedRevision: true, setupCompletedAt: true } },
        },
      });
      const [installation] = app.installations;
      return { ...app, installations: undefined, installation: installation! };
    },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (isAppError(error)) return `${error.code}:${error.errorId ?? ""}`;
    throw error;
  }
  return "not refused";
}

test.skipIf(!db)("an app needs no setup until its page is declared", async () => {
  const f = await fixture(db!);
  try {
    expect(await f.setup.read(f.installationId)).toMatchObject({
      status: "not_required",
      url: null,
      revision: 0,
      completedAt: null,
    });
    // Nothing to finish: a report is refused, whatever it says.
    expect(await f.setup.report(f.installationId, { revision: 0, status: "complete" })).toEqual({
      outcome: "not_required",
    });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "the revision moves only when the page changes or setup is turned on or off",
  async () => {
    const f = await fixture(db!);
    try {
      const revisions: number[] = [];
      for (const input of [
        { url: PAGE, description: "Connect your Acme account" },
        { url: PAGE, description: "Connect your Acme account" },
        { url: PAGE, description: "Another line" },
        { url: OTHER_PAGE, description: "Another line" },
        { url: null, description: "" },
        { url: null, description: "" },
        { url: PAGE, description: "" },
      ]) {
        revisions.push((await f.declare(input)).revision);
      }
      expect(revisions).toEqual([1, 1, 1, 2, 3, 3, 4]);
      expect(await f.stored()).toMatchObject({ setupUrl: PAGE, setupRevision: 4 });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an installation reports complete or pending for the current revision, and repeating it changes nothing",
  async () => {
    const f = await fixture(db!);
    try {
      const declared = await f.declare({ url: PAGE, description: "" });
      expect(declared.status).toBe("pending");
      const first = await f.setup.report(f.installationId, {
        revision: declared.revision,
        status: "complete",
      });
      expect(first).toMatchObject({ outcome: "recorded", setup: { status: "complete" } });
      const completedAt = (await f.stored()).installation.setupCompletedAt;
      expect(completedAt).toBeInstanceOf(Date);
      // The same report again keeps when it first completed.
      await f.setup.report(f.installationId, { revision: declared.revision, status: "complete" });
      expect((await f.stored()).installation.setupCompletedAt).toEqual(completedAt!);
      const back = await f.setup.report(f.installationId, {
        revision: declared.revision,
        status: "pending",
      });
      expect(back).toMatchObject({ outcome: "recorded", setup: { status: "pending" } });
      expect((await f.stored()).installation).toEqual({
        setupCompletedRevision: null,
        setupCompletedAt: null,
      });
      // Pending again, repeated.
      expect(
        await f.setup.report(f.installationId, { revision: declared.revision, status: "pending" }),
      ).toMatchObject({ outcome: "recorded", setup: { status: "pending" } });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a report for another revision is stale and changes nothing", async () => {
  const f = await fixture(db!);
  try {
    const declared = await f.declare({ url: PAGE, description: "" });
    await f.declare({ url: OTHER_PAGE, description: "" });
    expect(
      await f.setup.report(f.installationId, { revision: declared.revision, status: "complete" }),
    ).toEqual({ outcome: "stale" });
    expect((await f.stored()).installation.setupCompletedRevision).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "a new page is pending again, a new description is not, and turning setup off and on starts over",
  async () => {
    const f = await fixture(db!);
    try {
      const first = await f.declare({ url: PAGE, description: "" });
      await f.setup.report(f.installationId, { revision: first.revision, status: "complete" });
      expect(await f.declare({ url: PAGE, description: "New words" })).toMatchObject({
        status: "complete",
        description: "New words",
      });
      expect(await f.declare({ url: OTHER_PAGE, description: "New words" })).toMatchObject({
        status: "pending",
      });
      const second = await f.declare({ url: OTHER_PAGE, description: "New words" });
      await f.setup.report(f.installationId, { revision: second.revision, status: "complete" });
      // Off: nothing is required, whatever was finished.
      expect(await f.declare({ url: null, description: "" })).toMatchObject({
        status: "not_required",
        url: null,
      });
      // On again at the same address: a new setup, not the finished one.
      expect(await f.declare({ url: OTHER_PAGE, description: "" })).toMatchObject({
        status: "pending",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a new installation of the app starts pending", async () => {
  const f = await fixture(db!);
  const other = await db!.workspace.create({
    data: { slug: `setup-second-${RUN}`, name: "Second" },
  });
  try {
    const declared = await f.declare({ url: PAGE, description: "" });
    await f.setup.report(f.installationId, { revision: declared.revision, status: "complete" });
    const app = await db!.app.findUniqueOrThrow({ where: { key: f.key }, select: { id: true } });
    const second = await db!.appInstallation.create({
      data: { appId: app.id, workspaceId: other.id },
      select: { id: true },
    });
    expect(await f.setup.read(second.id)).toMatchObject({ status: "pending" });
    expect(await f.setup.read(f.installationId)).toMatchObject({ status: "complete" });
  } finally {
    await db!.workspace.delete({ where: { id: other.id } }).catch(() => {});
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "the opened page carries the installation, the Workspace and the revision",
  async () => {
    const f = await fixture(db!);
    try {
      const declared = await f.declare({ url: `${PAGE}?plan=pro`, description: "" });
      const link = new URL((await f.setup.read(f.installationId))!.link!);
      expect(`${link.origin}${link.pathname}`).toBe(PAGE);
      expect(Object.fromEntries(link.searchParams)).toEqual({
        plan: "pro",
        installation_id: f.installationId,
        workspace_id: f.workspaceId,
        setup_revision: String(declared.revision),
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("owners and admins declare; a member only reads, without the link", async () => {
  const f = await fixture(db!);
  try {
    await f.setup.declare(f.actor("admin"), f.key, { url: PAGE, description: "Words" });
    expect(
      await refusal(f.setup.declare(f.actor("member"), f.key, { url: null, description: "" })),
    ).toBe("ACCESS_DENIED:");
    const asAdmin = (await f.setup.workspaceSetups(f.actor("admin")))!.get(f.key)!;
    const asMember = (await f.setup.workspaceSetups(f.actor("member")))!.get(f.key)!;
    expect(asAdmin.link).toContain("installation_id=");
    expect(asMember).toMatchObject({
      status: "pending",
      url: PAGE,
      description: "Words",
      link: null,
    });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a page or description that breaks the rules is refused", async () => {
  const f = await fixture(db!);
  try {
    const url = (value: unknown) =>
      refusal(f.setup.declare(f.actor("owner"), f.key, { url: value, description: "" }));
    for (const bad of [
      "http://acme.example/setup",
      "https://user:pw@acme.example/setup",
      "https://acme.example/setup#top",
      "https://ACME.example/setup",
      `https://acme.example/${"a".repeat(2000)}`,
      "",
      7,
    ])
      expect(await url(bad)).toBe("INVALID_INPUT:app-setup-url-invalid");
    expect(await url("http://localhost:3000/setup")).toBe("not refused");
    expect(
      await refusal(
        f.setup.declare(f.actor("owner"), f.key, { url: PAGE, description: "x".repeat(501) }),
      ),
    ).toBe("INVALID_INPUT:app-setup-description-invalid");
    expect(
      await refusal(
        f.setup.declare(f.actor("owner"), f.key, { url: PAGE, description: "two\nlines" }),
      ),
    ).toBe("INVALID_INPUT:app-setup-description-invalid");
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("the editor's Save writes the profile and the setup as one change", async () => {
  const f = await fixture(db!);
  try {
    const save = createAppEditorSave(db!);
    const saved = await save.save(f.actor("owner"), f.key, {
      patch: { name: "Renamed" },
      setup: { url: PAGE, description: "Words" },
    });
    expect(saved.app.name).toBe("Renamed");
    expect(saved.setup).toMatchObject({ status: "pending", url: PAGE });
    // A profile field the registry refuses leaves the setup as it was.
    expect(
      await refusal(
        save.save(f.actor("owner"), f.key, {
          patch: { name: "" },
          setup: { url: OTHER_PAGE, description: "" },
        }),
      ),
    ).toBe("INVALID_INPUT:app-name-invalid");
    expect(await f.stored()).toMatchObject({ setupUrl: PAGE, setupRevision: 1, name: "Renamed" });
    // And a setup it refuses leaves the profile.
    expect(
      await refusal(
        save.save(f.actor("owner"), f.key, {
          patch: { name: "Again" },
          setup: { url: "http://acme.example/", description: "" },
        }),
      ),
    ).toBe("INVALID_INPUT:app-setup-url-invalid");
    expect((await f.stored()).name).toBe("Renamed");
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("with the flag off nothing is shown, declared or changed", async () => {
  const f = await fixture(db!, { flag: "off" });
  try {
    expect(await f.setup.workspaceSetups(f.actor("owner"))).toBeNull();
    expect(await f.setup.appSetup(f.actor("owner"), f.key)).toBeNull();
    expect(await refusal(f.declare({ url: PAGE, description: "" }))).toBe(
      "ACCESS_DENIED:app-installation-setup-off",
    );
    expect(await f.setup.lookup(f.key, f.workspaceId)).toBeUndefined();
    // A save leaves the setup columns as they are.
    const saved = await createAppEditorSave(db!).save(f.actor("owner"), f.key, {
      patch: { name: "Renamed" },
    });
    expect(saved.setup).toBeNull();
    expect(
      await refusal(
        createAppEditorSave(db!).save(f.actor("owner"), f.key, {
          patch: {},
          setup: { url: PAGE, description: "" },
        }),
      ),
    ).toBe("ACCESS_DENIED:app-installation-setup-off");
    expect(await f.stored()).toMatchObject({ setupUrl: null, setupRevision: 0 });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a lookup finds the installation of an app in a Workspace", async () => {
  const f = await fixture(db!);
  try {
    expect(await f.setup.lookup(f.key, f.workspaceId)).toMatchObject({
      installationId: f.installationId,
      workspaceId: f.workspaceId,
      status: "not_required",
    });
    expect(await f.setup.lookup(f.key, crypto.randomUUID())).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
