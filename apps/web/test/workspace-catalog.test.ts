import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";

import {
  WorkspaceCatalog,
  type WorkspaceCatalogStore,
  type WorkspaceRecord,
} from "#src/server/workspaces/catalog.server";

const ada = "11111111-1111-4111-8111-111111111111";
const grace = "22222222-2222-4222-8222-222222222222";

test("lists the User's Workspaces in creation order", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  await catalog.createForUser(grace, {
    name: "Grace's Workspace",
    slug: "grace",
  });
  expect(await catalog.listForUser(ada)).toEqual([
    { id: "workspace-ada", slug: "ada", name: "Ada's Workspace", iconUrl: null },
    { id: "workspace-research", slug: "research", name: "Research", iconUrl: null },
  ]);
});

test("selects the preferred Workspace when the User is a member", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  expect(await catalog.selectForUser(ada, "research")).toEqual({
    id: "workspace-research",
    slug: "research",
    name: "Research",
    iconUrl: null,
  });
});

test("falls back to the earliest Workspace when the preference is missing", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await catalog.createForUser(ada, { name: "Research", slug: "research" });
  expect(await catalog.selectForUser(ada, "unknown")).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Ada's Workspace",
    iconUrl: null,
  });
  expect(await catalog.selectForUser(ada)).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Ada's Workspace",
    iconUrl: null,
  });
});

test("rejects a taken or reserved Workspace slug", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  await expect(catalog.createForUser(grace, { name: "Other", slug: "ada" })).rejects.toEqual(
    new AppError("CONFLICT"),
  );
  await expect(catalog.createForUser(ada, { name: "Auth", slug: "auth" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
});

test("rejects an invalid Workspace slug or empty name", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  await expect(catalog.createForUser(ada, { name: "Ada", slug: "Ada" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  await expect(catalog.createForUser(ada, { name: "   ", slug: "team" })).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
});

test("does not expose unexpected persistence errors", async () => {
  const store = memoryStore();
  store.createForUser = async () => {
    throw new Error("internal database path");
  };

  await expect(
    new WorkspaceCatalog(store).createForUser(ada, {
      name: "Research",
      slug: "research",
    }),
  ).rejects.toThrow("workspace creation failed");
});

test("an owner or admin renames the Workspace to the trimmed name", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  expect(await catalog.rename(workspace.id, "owner", "  Research Lab  ")).toEqual({
    id: "workspace-ada",
    slug: "ada",
    name: "Research Lab",
    iconUrl: null,
  });
  await catalog.rename(workspace.id, "admin", "Grace's Lab");
  expect(await catalog.listForUser(ada)).toEqual([
    { id: "workspace-ada", slug: "ada", name: "Grace's Lab", iconUrl: null },
  ]);
});

test("a plain member, or an unrecognized role, cannot rename the Workspace", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  for (const role of ["member", "guest"])
    await expect(catalog.rename(workspace.id, role, "Taken over")).rejects.toEqual(
      new AppError("ACCESS_DENIED"),
    );
  expect((await catalog.listForUser(ada))[0]?.name).toBe("Ada's Workspace");
});

test("a Workspace name is 1 to 100 characters after trimming", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  await expect(catalog.rename(workspace.id, "owner", "   ")).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  await expect(catalog.rename(workspace.id, "owner", "x".repeat(101))).rejects.toEqual(
    new AppError("INVALID_INPUT"),
  );
  expect((await catalog.rename(workspace.id, "owner", ` ${"x".repeat(100)} `)).name).toBe(
    "x".repeat(100),
  );
});

test("only the owner changes the Workspace URL, and the old one keeps naming it", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "user" });

  for (const role of ["admin", "member", undefined])
    await expect(catalog.changeSlug(workspace.id, role, "ada")).rejects.toEqual(
      new AppError("ACCESS_DENIED"),
    );
  expect(await catalog.changeSlug(workspace.id, "owner", "  ada  ")).toEqual({
    id: workspace.id,
    slug: "ada",
    name: "Ada's Workspace",
    iconUrl: null,
  });
  expect(await catalog.listForUser(ada)).toEqual([
    { id: workspace.id, slug: "ada", name: "Ada's Workspace", iconUrl: null },
  ]);
});

test("a Workspace URL must be well formed and not reserved", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });

  for (const slug of ["Ada", "", "a--b", "-ada", "x".repeat(49), "settings"])
    await expect(catalog.changeSlug(workspace.id, "owner", slug)).rejects.toEqual(
      new AppError("INVALID_INPUT"),
    );
  expect((await catalog.listForUser(ada))[0]?.slug).toBe("ada");
});

test("a URL another Workspace has now, or had before, is taken for good", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const mine = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "ada" });
  const theirs = await catalog.createForUser(grace, { name: "Grace's Workspace", slug: "grace" });
  await catalog.changeSlug(theirs.id, "owner", "hopper");

  for (const slug of ["hopper", "grace"])
    await expect(catalog.changeSlug(mine.id, "owner", slug)).rejects.toEqual(
      new AppError("CONFLICT"),
    );
  await expect(catalog.createForUser(ada, { name: "Grace", slug: "grace" })).rejects.toEqual(
    new AppError("CONFLICT"),
  );
});

test("a Workspace can go back to a URL it had before, and keeping its URL changes nothing", async () => {
  const catalog = new WorkspaceCatalog(memoryStore());
  const workspace = await catalog.createForUser(ada, { name: "Ada's Workspace", slug: "user" });
  await catalog.changeSlug(workspace.id, "owner", "ada");

  expect((await catalog.changeSlug(workspace.id, "owner", "user")).slug).toBe("user");
  expect((await catalog.changeSlug(workspace.id, "owner", "user")).slug).toBe("user");
  expect((await catalog.changeSlug(workspace.id, "owner", "ada")).slug).toBe("ada");
});

function memoryStore(): WorkspaceCatalogStore {
  const workspaces: WorkspaceRecord[] = [];
  const members = new Map<string, string[]>();
  /** Former URLs, each naming the Workspace that had it. */
  const formerSlugs = new Map<string, string>();
  const unique = () => Object.assign(new Error("unique"), { code: "P2002" });
  const taken = (slug: string, by?: string) =>
    workspaces.some((workspace) => workspace.slug === slug && workspace.id !== by) ||
    (formerSlugs.has(slug) && formerSlugs.get(slug) !== by);
  return {
    async rename(workspaceId, name) {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!;
      workspace.name = name;
      return { ...workspace };
    },
    async changeSlug(workspaceId, slug) {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)!;
      if (workspace.slug === slug) return { ...workspace };
      if (taken(slug, workspaceId)) throw unique();
      formerSlugs.delete(slug);
      formerSlugs.set(workspace.slug, workspaceId);
      workspace.slug = slug;
      return { ...workspace };
    },
    async listForUser(userId) {
      const ids = members.get(userId) ?? [];
      return ids
        .map((id) => workspaces.find((workspace) => workspace.id === id))
        .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace))
        .map((workspace) => ({ ...workspace }));
    },
    async createForUser(input) {
      if (taken(input.slug)) throw unique();
      const workspace = {
        id: `workspace-${input.slug}`,
        slug: input.slug,
        name: input.name,
        iconUrl: null,
      };
      workspaces.push(workspace);
      const ids = members.get(input.userId) ?? [];
      ids.push(workspace.id);
      members.set(input.userId, ids);
      return { ...workspace };
    },
  };
}
