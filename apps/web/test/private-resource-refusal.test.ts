import { expect, test } from "bun:test";

import { Route as AgentAvatarRoute } from "#src/routes/api/workspaces/$workspaceId/agents/$agentId/avatar";
import { Route as WorkspaceIconRoute } from "#src/routes/api/workspaces/$workspaceId/icon";
import { Route as ProjectIconRoute } from "#src/routes/api/projects.$projectId.icon";
import { Route as ProjectRawRoute } from "#src/routes/api/projects.$projectId.raw.$";
import { handleWorkspaceUserAvatar } from "#src/server/profiles/workspace-user-avatar.server";
import { privateResourceRefusal } from "#src/server/http/private-resource-refusal.server";
import { AppError } from "#src/lib/app-error";

// The private image and file routes answer a refusal the same way: `{ code }` as JSON, never
// cached, 401 for a missing session, 404 for anything that is not there or not visible, 503
// otherwise. These pin that answer on each of them.

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>;
const get = (route: { options: { server?: unknown } }) =>
  (route.options.server as { handlers: { GET: Handler } }).handlers.GET;

const routes = [
  ["workspace icon", WorkspaceIconRoute, { workspaceId: "not-a-uuid" }],
  ["Agent avatar", AgentAvatarRoute, { workspaceId: "not-a-uuid", agentId: "not-a-uuid" }],
  ["project icon", ProjectIconRoute, { projectId: "not-a-uuid" }],
  ["project raw file", ProjectRawRoute, { projectId: "not-a-uuid", _splat: "README.md" }],
] as const;

async function refusal(response: Response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

async function withDevSkipAuth<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const previous = process.env.COFORGE_DEV_SKIP_AUTH;
  if (enabled) process.env.COFORGE_DEV_SKIP_AUTH = "1";
  else delete process.env.COFORGE_DEV_SKIP_AUTH;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.COFORGE_DEV_SKIP_AUTH;
    else process.env.COFORGE_DEV_SKIP_AUTH = previous;
  }
}

for (const [name, route, params] of routes) {
  test(`${name}: no session is a 401 ACCESS_DENIED, not cached`, async () => {
    const response = await withDevSkipAuth(false, () =>
      get(route)({ request: new Request("http://localhost/"), params }),
    );
    expect(await refusal(response)).toEqual({
      status: 401,
      cacheControl: "no-store",
      body: { code: "ACCESS_DENIED" },
    });
  });

  test(`${name}: a malformed id is a 404 NOT_FOUND, not cached`, async () => {
    const response = await withDevSkipAuth(true, () =>
      get(route)({ request: new Request("http://localhost/"), params }),
    );
    expect(await refusal(response)).toEqual({
      status: 404,
      cacheControl: "no-store",
      body: { code: "NOT_FOUND" },
    });
  });
}

test("workspace user avatar: 401 without a viewer, 404 when not visible, 503 without a database", async () => {
  const request = new Request("http://localhost/");
  const missing = { findFirst: async () => null };
  const database = () => ({ workspaceMembership: missing }) as never;

  expect(
    await refusal(await handleWorkspaceUserAvatar(request, "w", "u", { authenticate: () => null })),
  ).toEqual({ status: 401, cacheControl: "no-store", body: { code: "ACCESS_DENIED" } });
  expect(
    await refusal(
      await handleWorkspaceUserAvatar(request, "w", "u", {
        authenticate: () => ({ id: "viewer" }),
        database,
      }),
    ),
  ).toEqual({ status: 404, cacheControl: "no-store", body: { code: "NOT_FOUND" } });
  expect(
    await refusal(
      await handleWorkspaceUserAvatar(request, "w", "u", {
        authenticate: () => ({ id: "viewer" }),
        database: () => null,
      }),
    ),
  ).toEqual({ status: 503, cacheControl: "no-store", body: { code: "TEMPORARILY_UNAVAILABLE" } });
});

test("privateResourceRefusal rethrows anything that is not an AppError, unchanged", () => {
  const failure = new Error("database exploded");
  expect(() => privateResourceRefusal(failure)).toThrow(failure);
  expect(() => privateResourceRefusal("not an error")).toThrow();
});

test("privateResourceRefusal maps any other AppError code to 503", async () => {
  expect(await refusal(privateResourceRefusal(new AppError("TEMPORARILY_UNAVAILABLE")))).toEqual({
    status: 503,
    cacheControl: "no-store",
    body: { code: "TEMPORARILY_UNAVAILABLE" },
  });
});
