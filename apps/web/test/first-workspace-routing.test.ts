import { beforeEach, expect, test } from "bun:test";
import { mockModuleForFile } from "./helpers/file-module-mock";
import { QueryClient } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";

import { AppError } from "#src/lib/app-error";

let signedIn = false;
let named = true;
let startPage: string | null = null;

await mockModuleForFile("#src/features/auth/current-user.functions", () => ({
  getAuthenticationStatus: async () => signedIn,
  getSignedInAccount: async () => (signedIn ? { account: "Ada Lovelace", named } : null),
}));
await mockModuleForFile("#src/features/profiles/profile.functions", () => ({
  getUserProfile: async () => ({ id: "user-1", name: "Ada Lovelace", named }),
}));
await mockModuleForFile("#src/features/workspaces/last-location.functions", () => ({
  getStartPage: async () => startPage,
}));
const workspaceFunctions = await import("#src/features/workspaces/workspaces.functions");
await mockModuleForFile("#src/features/workspaces/workspaces.functions", () => ({
  ...workspaceFunctions,
  openWorkspace: async () => {
    throw new AppError("NOT_FOUND");
  },
  loadWorkspaceSwitcher: async () => ({
    workspaces: [],
    current: { id: "workspace-1", slug: "acme", name: "Acme" },
  }),
}));
const workspaceReads = {
  "#src/features/notifications/notifications.functions": { getBrowserNotificationSettings: {} },
  "#src/features/agents/workspace-agents.functions": {
    loadWorkspaceAgents: { agents: [], extraAgents: [], streamPositions: {} },
  },
  "#src/features/settings/settings.functions": { getUserPreferences: {} },
  "#src/features/pi-chat/pi-chat.functions": { loadAiWorkbenchOn: true },
  "#src/features/workspaces/member-settings.functions": {
    loadMemberWorkspaceSettings: { tabOrders: {}, setupPending: false },
  },
  "#src/features/records/records.functions": { loadRecordsNavAttention: { preview: false } },
} as const;
for (const [path, reads] of Object.entries(workspaceReads)) {
  const real = await import(path);
  await mockModuleForFile(path, () => ({
    ...real,
    ...Object.fromEntries(Object.entries(reads).map(([name, value]) => [name, async () => value])),
  }));
}
await mockModuleForFile("#src/features/settings/assumed-viewport.functions", () => ({
  loadAssumedPhone: () => false,
}));
await mockModuleForFile("#src/features/settings/time-zone-cookie.functions", () => ({
  loadCookieTimeZone: () => undefined,
}));
let visitorUrl: string | null | Error = null;
await mockModuleForFile("#src/features/artifacts/artifact-visitor.functions", () => ({
  artifactVisitorUrl: async () => {
    if (visitorUrl instanceof Error) throw visitorUrl;
    return visitorUrl;
  },
}));
let joinPreview: unknown = null;
const joinFunctions = await import("#src/features/workspaces/join-links.functions");
await mockModuleForFile("#src/features/workspaces/join-links.functions", () => ({
  ...joinFunctions,
  inspectWorkspaceJoinLink: async () => joinPreview,
}));

const { Route: rootPage } = await import("#src/routes/index");
const { Route: workspaceLayout } = await import("#src/routes/w.$workspaceSlug");
const { Route: firstWorkspacePage } = await import("#src/routes/workspaces.new");
const { Route: joinPage } = await import("#src/routes/join.$token");

beforeEach(() => {
  signedIn = false;
  named = true;
  startPage = null;
  joinPreview = null;
  visitorUrl = null;
});

async function landing(
  beforeLoad: ((args: never) => unknown) | undefined,
  args: object,
): Promise<unknown> {
  expect(beforeLoad).toBeDefined();
  try {
    await beforeLoad!({
      context: { queryClient: new QueryClient() },
      preload: false,
      ...args,
    } as never);
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

function redirectTarget(thrown: unknown): string | undefined {
  if (!isRedirect(thrown)) return undefined;
  return thrown.options.href ?? String(thrown.options.to);
}

function nameStepTarget(thrown: unknown): { to?: string; returnTo?: string } | undefined {
  if (!isRedirect(thrown)) return undefined;
  const search = thrown.options.search as { returnTo?: string } | undefined;
  return { to: String(thrown.options.to), returnTo: search?.returnTo };
}

async function loaded(loader: unknown, args: object): Promise<unknown> {
  if (typeof loader !== "function") throw new Error("the route has no loader function");
  try {
    return await loader(args);
  } catch (thrown) {
    return thrown;
  }
}

const atRoot = { location: { searchStr: "" } };

test("a signed-in person in no Workspace is sent from `/` to create their first one", async () => {
  signedIn = true;
  expect(redirectTarget(await landing(rootPage.options.beforeLoad, atRoot))).toBe(
    "/workspaces/new",
  );
});

test("a signed-in person with a Workspace still opens it from `/`", async () => {
  signedIn = true;
  startPage = "/w/acme/tasks";
  expect(redirectTarget(await landing(rootPage.options.beforeLoad, atRoot))).toContain(
    "/w/acme/tasks",
  );
});

test("a signed-out visitor stays on the public home page", async () => {
  expect(await landing(rootPage.options.beforeLoad, atRoot)).toBeUndefined();
});

test("a Workspace URL a person in no Workspace cannot open sends them to create their first one", async () => {
  signedIn = true;
  const thrown = await landing(workspaceLayout.options.beforeLoad, {
    params: { workspaceSlug: "gone" },
    location: { href: "/w/gone" },
  });
  expect(redirectTarget(thrown)).toBe("/workspaces/new");
});

test("a Workspace URL that is not theirs is still not found for a person with Workspaces", async () => {
  signedIn = true;
  startPage = "/w/acme";
  const thrown = await landing(workspaceLayout.options.beforeLoad, {
    params: { workspaceSlug: "gone" },
    location: { href: "/w/gone" },
  });
  expect(isNotFound(thrown)).toBe(true);
});

const publicArtifactPage = {
  params: { workspaceSlug: "acme" },
  location: { href: "/w/acme/artifacts/0199e1f2-3c4d-7a5b-8c6d-7e8f9a0b1c2d" },
};

test("a public artifact's page sends a visitor who cannot read it to its public link", async () => {
  visitorUrl = "https://a-0199e1f2.usercontent.example/p/token";
  const thrown = await landing(workspaceLayout.options.beforeLoad, publicArtifactPage);
  expect(redirectTarget(thrown)).toBe(visitorUrl);
});

test("an artifact's page the visitor gets no public link for goes on to open the Workspace", async () => {
  signedIn = true;
  const thrown = await landing(workspaceLayout.options.beforeLoad, publicArtifactPage);
  expect(redirectTarget(thrown)).toBe("/workspaces/new");
});

test("the first-Workspace page shows for a signed-in person in no Workspace", async () => {
  signedIn = true;
  expect(await landing(firstWorkspacePage.options.beforeLoad, {})).toBeUndefined();
});

test("the first-Workspace page sends a person who has Workspaces back to theirs", async () => {
  signedIn = true;
  startPage = "/w/acme";
  expect(redirectTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toContain(
    "/w/acme",
  );
});

test("the first-Workspace page asks a signed-out visitor to sign in", async () => {
  expect(redirectTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toBe("/login");
});

test("the first-Workspace page asks an unnamed person for their name first", async () => {
  signedIn = true;
  named = false;
  expect(nameStepTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toEqual({
    to: "/welcome",
    returnTo: "/workspaces/new",
  });
});

test("an invite link asks an unnamed person for their name first, and comes back to the link", async () => {
  signedIn = true;
  named = false;
  joinPreview = { name: "Acme" };
  const thrown = await loaded(joinPage.options.loader, { params: { token: "abc123" } });
  expect(nameStepTarget(thrown)).toEqual({ to: "/welcome", returnTo: "/join/abc123" });
});

test("an invite link is shown as it is to a named person, and to a signed-out visitor", async () => {
  joinPreview = { name: "Acme" };
  expect(await loaded(joinPage.options.loader, { params: { token: "abc123" } })).toEqual({
    preview: { name: "Acme" },
    viewerAccount: null,
  });
  signedIn = true;
  expect(await loaded(joinPage.options.loader, { params: { token: "abc123" } })).toEqual({
    preview: { name: "Acme" },
    viewerAccount: "Ada Lovelace",
  });
});

test("the Workspace layout asks an unnamed person for their name first, and comes back to the page", async () => {
  signedIn = true;
  named = false;
  const thrown = await loaded(workspaceLayout.options.loader, {
    location: { href: "/w/acme/channel/general?thread=1" },
    params: { workspaceSlug: "acme" },
    context: { queryClient: new QueryClient() },
  });
  expect(nameStepTarget(thrown)).toEqual({
    to: "/welcome",
    returnTo: "/w/acme/channel/general?thread=1",
  });
});

test("the Workspace layout loads for a named person", async () => {
  signedIn = true;
  const result = await loaded(workspaceLayout.options.loader, {
    location: { href: "/w/acme/tasks" },
    params: { workspaceSlug: "acme" },
    context: { queryClient: new QueryClient() },
  });
  expect(isRedirect(result)).toBe(false);
  expect(result).toMatchObject({ user: { id: "user-1" } });
});

test("an artifact's page whose public link check fails still opens the Workspace", async () => {
  signedIn = true;
  visitorUrl = new Error("session store unavailable");
  const thrown = await landing(workspaceLayout.options.beforeLoad, publicArtifactPage);
  expect(redirectTarget(thrown)).toBe("/workspaces/new");
});
