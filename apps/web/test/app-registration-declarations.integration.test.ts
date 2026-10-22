import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { createAppEditorSave } from "#src/server/app-permissions/app-permissions-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";

/**
 * Registering an app with the data groups and the setup page it declares, against local PostgreSQL
 * with migrations applied: one change with the registration, so a refusal of any part registers
 * nothing, and the registering Workspace's installation starts with the groups pending approval.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 8 }, (_, index) => `reg-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;

const onFor = () => ({
  state: "ENABLED",
  variants: { on: true, off: false },
  defaultVariant: "off",
  targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
});

beforeAll(async () => {
  if (!db) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-registration-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: { "app-data-permissions": onFor(), "app-installation-setup": onFor() },
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

async function fixture(db: PrismaClient, { flags = "on" }: { flags?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = flags === "on" ? ON_SLUGS[nextOnSlug++]! : `reg-off-${suffix}`;
  const person = (role: string) => ({
    displayName: `reg-${role}-${suffix}`,
    username: `reg-${role}-${suffix}`,
  });
  const people = {
    owner: await db.user.create({ data: person("owner") }),
    member: await db.user.create({ data: person("member") }),
  };
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Registration",
      members: {
        create: Object.entries(people).map(([role, user]) => ({ userId: user.id, role })),
      },
    },
  });
  const actor = (role: keyof typeof people) => ({
    workspaceId: workspace.id,
    actorUserId: people[role].id,
  });
  const key = `reg-${suffix}`;
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
  return {
    key,
    registration,
    actor,
    stored: () =>
      db.app.findUnique({
        where: { key },
        select: {
          permissionGroups: true,
          permissionRevision: true,
          setupUrl: true,
          setupDescription: true,
          setupRevision: true,
          installations: { select: { approvedGroups: true, approvedRevision: true } },
        },
      }),
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user
        .deleteMany({ where: { id: { in: Object.values(people).map((user) => user.id) } } })
        .catch(() => {});
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return `${error.code}:${error.errorId}`;
    throw error;
  }
  throw new Error("expected a refusal");
}

test.skipIf(!db)(
  "registering with data groups and a setup page writes them with the app, groups pending approval",
  async () => {
    const f = await fixture(db!);
    try {
      const registered = await createAppEditorSave(db!).register(f.actor("owner"), f.registration, {
        permissionGroups: ["workspace", "agent"],
        setup: { url: PAGE, description: "Connect your account." },
      });
      expect(registered.app.key).toBe(f.key);
      expect(registered.clientSecret).toBeTruthy();
      expect(registered.permissions).toMatchObject({
        declared: ["workspace", "agent"],
        revision: 1,
        effective: [],
        pending: ["workspace", "agent"],
      });
      expect(registered.setup).toMatchObject({ status: "pending", url: PAGE });
      expect(await f.stored()).toMatchObject({
        permissionGroups: ["workspace", "agent"],
        permissionRevision: 1,
        setupUrl: PAGE,
        setupDescription: "Connect your account.",
        setupRevision: 1,
        installations: [{ approvedGroups: [] }],
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a registration without declarations registers as before", async () => {
  const f = await fixture(db!);
  try {
    const registered = await createAppEditorSave(db!).register(
      f.actor("owner"),
      f.registration,
      {},
    );
    expect(registered.permissions).toMatchObject({ declared: [], revision: 0 });
    expect(registered.setup).toMatchObject({ status: "not_required", url: null });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a refused declaration registers nothing", async () => {
  const f = await fixture(db!);
  const save = createAppEditorSave(db!);
  try {
    expect(
      await refusal(
        save.register(f.actor("owner"), f.registration, {
          permissionGroups: ["messages"],
          setup: { url: PAGE, description: "" },
        }),
      ),
    ).toBe("INVALID_INPUT:app-permission-groups-invalid");
    expect(await f.stored()).toBeNull();
    expect(
      await refusal(
        save.register(f.actor("owner"), f.registration, {
          permissionGroups: ["workspace"],
          setup: { url: "http://acme.example/", description: "" },
        }),
      ),
    ).toBe("INVALID_INPUT:app-setup-url-invalid");
    expect(await f.stored()).toBeNull();
    // A member may not register at all.
    expect(
      await refusal(save.register(f.actor("member"), f.registration, { permissionGroups: [] })),
    ).toMatch(/^ACCESS_DENIED/);
    expect(await f.stored()).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a taken key is refused and leaves the first app as it was", async () => {
  const f = await fixture(db!);
  const save = createAppEditorSave(db!);
  try {
    await save.register(f.actor("owner"), f.registration, { permissionGroups: ["agent"] });
    expect(
      await refusal(
        save.register(f.actor("owner"), f.registration, { permissionGroups: ["workspace"] }),
      ),
    ).toBe("CONFLICT:app-key-taken");
    expect(await f.stored()).toMatchObject({ permissionGroups: ["agent"] });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)("a blank key is made from the name, with the declarations", async () => {
  const f = await fixture(db!);
  try {
    const registered = await createAppEditorSave(db!).register(
      f.actor("owner"),
      { ...f.registration, key: "" },
      { permissionGroups: ["computer"] },
    );
    expect(registered.app.key).toMatch(/^acme-insights-/);
    expect(registered.permissions).toMatchObject({ declared: ["computer"] });
    await db!.app.delete({ where: { key: registered.app.key } });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "declarations are refused where their flag is off, registering nothing",
  async () => {
    const f = await fixture(db!, { flags: "off" });
    const save = createAppEditorSave(db!);
    try {
      expect(
        await refusal(
          save.register(f.actor("owner"), f.registration, { permissionGroups: ["agent"] }),
        ),
      ).toBe("ACCESS_DENIED:app-data-permissions-off");
      expect(
        await refusal(
          save.register(f.actor("owner"), f.registration, {
            setup: { url: PAGE, description: "" },
          }),
        ),
      ).toBe("ACCESS_DENIED:app-installation-setup-off");
      expect(await f.stored()).toBeNull();
      const plain = await save.register(f.actor("owner"), f.registration, {});
      expect(plain.permissions).toBeNull();
      expect(plain.setup).toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
