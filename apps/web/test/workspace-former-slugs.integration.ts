import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaWorkspaceAccess } from "#src/server/db/repositories/setup.repositories.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import {
  PrismaWorkspaceEnrollmentStore,
  WorkspaceEnrollment,
} from "#src/server/workspaces/enrollment.server";

test("a changed Workspace URL keeps its old slug for that Workspace and no other", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = (label: string) => `${label}-${suffix}`;
  const catalog = new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
  const access = new PrismaWorkspaceAccess(db);
  try {
    const [owner, outsider] = await Promise.all(
      ["owner", "outsider"].map((name) =>
        db.user.create({ data: { username: `former-slug-${name}-${suffix}` } }),
      ),
    );
    const workspace = await catalog.createForUser(owner!.id, {
      name: "Ada's Workspace",
      slug: slug("user"),
    });

    const changed = await catalog.changeSlug(workspace.id, "owner", slug("ada"));

    expect(changed).toMatchObject({ id: workspace.id, slug: slug("ada") });
    // The old URL, and `workspace:get`/`computer:register` with it, still find the Workspace and
    // answer with its current slug.
    for (const name of [slug("user"), slug("ada")])
      expect(await access.findAccessibleBySlug(name, { userId: owner!.id })).toEqual({
        id: workspace.id,
        slug: slug("ada"),
        name: "Ada's Workspace",
      });
    // Only for a member.
    expect(await access.findAccessibleBySlug(slug("user"), { userId: outsider!.id })).toBe(
      undefined,
    );
    // Nobody else can take the old slug, by creating a Workspace or by moving one there.
    await expect(
      catalog.createForUser(outsider!.id, { name: "Taken", slug: slug("user") }),
    ).rejects.toEqual(new AppError("CONFLICT"));
    const theirs = await catalog.createForUser(outsider!.id, {
      name: "Grace's Workspace",
      slug: slug("grace"),
    });
    await expect(catalog.changeSlug(theirs.id, "owner", slug("user"))).rejects.toEqual(
      new AppError("CONFLICT"),
    );
    // A personal Workspace made at first sign-in steps around it, as around a taken slug.
    const newcomer = await db.user.create({ data: { username: slug("user") } });
    const { workspaceId } = await new WorkspaceEnrollment(
      new PrismaWorkspaceEnrollmentStore(db),
    ).ensureForUser({ id: newcomer.id, username: slug("user"), displayName: "Newcomer" }, "en");
    const personal = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(personal.slug).not.toBe(slug("user"));
    // The owner may go back to it.
    expect((await catalog.changeSlug(workspace.id, "owner", slug("user"))).slug).toBe(slug("user"));
    expect(await access.findAccessibleBySlug(slug("ada"), { userId: owner!.id })).toMatchObject({
      id: workspace.id,
      slug: slug("user"),
    });
  } finally {
    // Setup may have stopped part way, so clean up by the run's suffix rather than by created rows.
    await db.workspace.deleteMany({ where: { slug: { endsWith: suffix } } });
    await db.user.deleteMany({ where: { username: { contains: suffix } } });
    await db.$disconnect();
  }
});

test("two URL changes of one Workspace at once leave every slug it ever had reserved for it", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = (label: string) => `${label}-${suffix}`;
  const catalog = new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
  try {
    const owner = await db.user.create({ data: { username: `former-slug-race-${suffix}` } });
    const workspace = await catalog.createForUser(owner.id, { name: "Race", slug: slug("a") });

    const moves = await Promise.allSettled(
      ["b", "c", "d"].map((label) => catalog.changeSlug(workspace.id, "owner", slug(label))),
    );

    expect(moves.every((move) => move.status === "fulfilled")).toBe(true);
    const { slug: current } = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { slug: true },
    });
    const former = await db.workspaceFormerSlug.findMany({
      where: { workspaceId: workspace.id },
      select: { slug: true },
    });
    expect([current, ...former.map((row) => row.slug)].sort()).toEqual(
      ["a", "b", "c", "d"].map(slug),
    );
  } finally {
    await db.workspace.deleteMany({ where: { slug: { endsWith: suffix } } });
    await db.user.deleteMany({ where: { username: { contains: suffix } } });
    await db.$disconnect();
  }
});
