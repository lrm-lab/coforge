import { expect, test } from "bun:test";

import { FirstSignIn, type FirstSignInNames } from "#src/server/auth/first-sign-in.server";
import {
  WorkspaceEnrollment,
  type WorkspaceEnrollmentStore,
} from "#src/server/workspaces/enrollment.server";

// The first sign-in's name step, at its use-case seam: a person's display name is saved, then their
// personal Workspace is made, titled with it. Both stores are in memory, so the tests read the
// outcome through the same interface the callback and the page use.

const ada = { id: "11111111-1111-4111-8111-111111111111", username: "ada" };

function setup(
  input: {
    named?: Record<string, string>;
    memberships?: Record<string, string>;
    /** Whether the person's row exists; a session can outlive it. */
    userExists?: boolean;
    /** Slugs another Workspace has or had. */
    takenSlugs?: string[];
    startCloudComputer?: (input: {
      userId: string;
      workspaceId: string;
      now: Date;
    }) => Promise<unknown>;
    bindWeeklyReportAssistant?: (input: {
      userId: string;
      workspaceId: string;
      computerId: string;
    }) => Promise<unknown>;
  } = {},
) {
  const users = new Set(input.userExists === false ? [] : [ada.id]);
  const names = new Map(Object.entries(input.named ?? {}));
  const memberships = new Map(Object.entries(input.memberships ?? {}));
  const created: { slug: string; name: string; userId: string }[] = [];
  const taken = new Set(input.takenSlugs ?? []);
  const enrollmentStore: WorkspaceEnrollmentStore = {
    async findMembership(userId) {
      return memberships.get(userId) ?? null;
    },
    async createForUser(workspace) {
      if (taken.has(workspace.slug)) throw Object.assign(new Error("unique"), { code: "P2002" });
      taken.add(workspace.slug);
      created.push(workspace);
      const workspaceId = `workspace-${workspace.slug}`;
      memberships.set(workspace.userId, workspaceId);
      return workspaceId;
    },
  };
  const nameStore: FirstSignInNames = {
    async lookup(userId) {
      return users.has(userId) ? { displayName: names.get(userId) ?? null } : null;
    },
    async setDisplayNameOnce(userId, displayName) {
      if (!names.has(userId)) names.set(userId, displayName);
      return names.get(userId)!;
    },
  };
  return {
    firstSignIn: new FirstSignIn(
      nameStore,
      new WorkspaceEnrollment(enrollmentStore),
      input.startCloudComputer,
      input.bindWeeklyReportAssistant,
    ),
    names,
    created,
  };
}

test("completing first sign-in assigns the default cloud computer to the personal workspace", async () => {
  const started: Array<{ userId: string; workspaceId: string }> = [];
  const { firstSignIn } = setup({
    startCloudComputer: async (request) => {
      started.push({ userId: request.userId, workspaceId: request.workspaceId });
    },
  });

  const result = await firstSignIn.complete({
    user: ada,
    displayName: "Ada Lovelace",
    acceptLanguage: "en",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-ada" });
  expect(started).toEqual([{ userId: ada.id, workspaceId: "workspace-ada" }]);
});

test("completing first sign-in binds the weekly-report assistant to the default cloud computer", async () => {
  const bound: Array<{ userId: string; workspaceId: string; computerId: string }> = [];
  const { firstSignIn } = setup({
    startCloudComputer: async () => ({
      computerId: "cloud-1",
      slot: "default",
      name: "Cloud",
      containerReady: false,
      jobId: null,
    }),
    bindWeeklyReportAssistant: async (request) => {
      bound.push(request);
    },
  });

  const result = await firstSignIn.complete({
    user: ada,
    displayName: "Ada Lovelace",
    acceptLanguage: "en",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-ada" });
  expect(bound).toEqual([{ userId: ada.id, workspaceId: "workspace-ada", computerId: "cloud-1" }]);
});

test("a display name is saved, and the personal Workspace is titled with it", async () => {
  const { firstSignIn, names, created } = setup();

  const result = await firstSignIn.complete({
    user: ada,
    displayName: "  Ada   Lovelace ",
    acceptLanguage: "en-US",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-ada" });
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toEqual([{ slug: "ada", name: "Ada Lovelace's Workspace", userId: ada.id }]);
});

test("the Workspace title follows the language the person reads", async () => {
  const { firstSignIn, created } = setup();

  await firstSignIn.complete({ user: ada, displayName: "安栋", acceptLanguage: "zh-CN,zh;q=0.9" });

  expect(created.map((workspace) => workspace.name)).toEqual(["安栋的工作区"]);
});

test("a name that is not accepted saves nothing and makes no Workspace", async () => {
  const { firstSignIn, names, created } = setup();

  expect(
    await firstSignIn.complete({ user: ada, displayName: "   ", acceptLanguage: "en" }),
  ).toEqual({
    ok: false,
    problem: "empty",
  });
  expect(
    await firstSignIn.complete({ user: ada, displayName: "a".repeat(81), acceptLanguage: "en" }),
  ).toEqual({ ok: false, problem: "too_long" });
  expect(
    await firstSignIn.complete({ user: ada, displayName: "System", acceptLanguage: "en" }),
  ).toEqual({ ok: false, problem: "refused" });
  expect(names.size).toBe(0);
  expect(created).toEqual([]);
});

test("someone already in a Workspace keeps it: the name is saved and their memberships come back as they are", async () => {
  const { firstSignIn, names, created } = setup({ memberships: { [ada.id]: "workspace-team" } });

  const result = await firstSignIn.complete({
    user: ada,
    displayName: "Ada Lovelace",
    acceptLanguage: "en",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-team" });
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toEqual([]);
});

test("the name step is idempotent: a second submit, even with another name, changes nothing", async () => {
  const { firstSignIn, names, created } = setup();

  const first = await firstSignIn.complete({
    user: ada,
    displayName: "Ada Lovelace",
    acceptLanguage: "en",
  });
  const second = await firstSignIn.complete({
    user: ada,
    displayName: "Ada King",
    acceptLanguage: "en",
  });

  expect(second).toEqual(first);
  expect(names.get(ada.id)).toBe("Ada Lovelace");
  expect(created).toHaveLength(1);
});

test("a named person who has no Workspace gets one titled with the name already stored", async () => {
  const { firstSignIn, created } = setup({ named: { [ada.id]: "Ada Lovelace" } });

  await firstSignIn.complete({ user: ada, displayName: "Someone Else", acceptLanguage: "en" });

  expect(created.map((workspace) => workspace.name)).toEqual(["Ada Lovelace's Workspace"]);
});

// What the /welcome page needs to know: whether to ask at all, and what to start the field with.

test("a person who has a display name is not asked", async () => {
  const { firstSignIn } = setup({ named: { [ada.id]: "Ada Lovelace" } });

  expect(await firstSignIn.readNameStep({ id: ada.id, name: "Ada", username: "ada" })).toEqual({
    status: "named",
  });
});

test("a person without one is asked, starting from the provider's name when it reads as a name", async () => {
  const { firstSignIn } = setup();

  expect(
    await firstSignIn.readNameStep({ id: ada.id, name: " Ada  Lovelace ", username: "ada" }),
  ).toEqual({
    status: "ask",
    prefill: "Ada Lovelace",
    slugPrefill: "ada",
  });
  expect(
    await firstSignIn.readNameStep({ id: ada.id, name: "13800138000", username: "ada" }),
  ).toEqual({
    status: "ask",
    prefill: "",
    slugPrefill: "ada",
  });
  expect(await firstSignIn.readNameStep({ id: ada.id, name: "", username: "ada" })).toEqual({
    status: "ask",
    prefill: "",
    slugPrefill: "ada",
  });
});

test("a session whose user is gone is not asked: it has to sign in again", async () => {
  const { firstSignIn } = setup({ userExists: false });

  expect(await firstSignIn.readNameStep({ id: ada.id, name: "Ada", username: "ada" })).toEqual({
    status: "account_gone",
  });
});

test("a name the rule refuses is told apart from an empty or a too-long one", async () => {
  const { firstSignIn, names, created } = setup();
  const ask = (displayName: string) =>
    firstSignIn.complete({ user: ada, displayName, acceptLanguage: "en" });

  expect(await ask("@ada")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("\u200b")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("Ada\u202eLovelace")).toEqual({ ok: false, problem: "refused" });
  expect(await ask("")).toEqual({ ok: false, problem: "empty" });
  expect(names.size).toBe(0);
  expect(created).toEqual([]);
});

// The personal Workspace's URL: the person chooses it on the same page as their name.

test("the personal Workspace gets the URL the person chose", async () => {
  const { firstSignIn, created } = setup();

  const result = await firstSignIn.complete({
    user: { id: ada.id, username: "user-2" },
    displayName: "Ada Lovelace",
    workspaceSlug: "  lovelace-lab ",
    acceptLanguage: "en",
  });

  expect(result).toEqual({ ok: true, workspaceId: "workspace-lovelace-lab" });
  expect(created.map((workspace) => workspace.slug)).toEqual(["lovelace-lab"]);
});

test("a URL that is malformed, reserved or taken saves nothing, so the person can choose again", async () => {
  const { firstSignIn, names, created } = setup({ takenSlugs: ["ada"] });
  const ask = (workspaceSlug: string) =>
    firstSignIn.complete({ user: ada, displayName: "Ada", workspaceSlug, acceptLanguage: "en" });

  expect(await ask("Ada Lab")).toEqual({ ok: false, problem: "slug_invalid" });
  expect(await ask("settings")).toEqual({ ok: false, problem: "slug_invalid" });
  expect(await ask("ada")).toEqual({ ok: false, problem: "slug_taken" });
  expect(names.size).toBe(0);
  expect(created).toEqual([]);

  expect(await ask("ada-2")).toEqual({ ok: true, workspaceId: "workspace-ada-2" });
  expect(names.get(ada.id)).toBe("Ada");
});

test("the URL field starts from the username, unless that is only the fallback name", async () => {
  const { firstSignIn } = setup();
  const step = (username: string) =>
    firstSignIn.readNameStep({ id: ada.id, name: "Ada", username });

  expect(await step("ada_lovelace")).toMatchObject({ status: "ask", slugPrefill: "ada-lovelace" });
  for (const username of ["user", "user-2", "user-1a2b3c4d", "settings"])
    expect(await step(username)).toMatchObject({ status: "ask", slugPrefill: "" });
});
