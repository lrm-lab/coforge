import { expect, test } from "bun:test";
import { Route } from "#src/routes/api/agent/v1/users/$name";

const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.GET !== "function")
  throw new Error("missing GET handler");
const get = handlers.GET;

const PRINCIPAL = { workspaceId: "workspace-1", agentId: "agent-helper" };

type TimeZonePreferences = { timeZone: string | null; observedTimeZone: string | null } | null;

function baseDb(preferences: TimeZonePreferences) {
  return {
    agent: {
      findFirst: async () => null,
    },
    workspaceMembership: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; user: { username: string } };
      }) =>
        where.workspaceId === PRINCIPAL.workspaceId && where.user.username === "alice"
          ? {
              role: "member",
              user: {
                id: "user-alice",
                username: "alice",
                displayName: "Alice Chen",
                description: "",
                preferences,
              },
            }
          : null,
    },
    conversation: { findMany: async () => [] },
  };
}

async function request(name: string, preferences: TimeZonePreferences = null) {
  return (await get({
    context: { principal: PRINCIPAL, db: baseDb(preferences) },
    params: { name },
  } as unknown as Parameters<typeof get>[0])) as Response;
}

test("GET /api/agent/v1/users/:name returns the ok envelope for a known human", async () => {
  const response = await request("alice");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; user: { kind: string; name: string } };
  expect(body.ok).toBe(true);
  expect(body.user).toMatchObject({ kind: "human", name: "alice" });
});

test("GET /api/agent/v1/users/:name 404s with the Manual-style error envelope for an unknown name", async () => {
  const response = await request("ghost");
  expect(response.status).toBe(404);
  const body = (await response.json()) as { ok: boolean; errorCode: string; error: string };
  expect(body).toEqual({
    ok: false,
    errorCode: "user_not_found",
    error: "User not found or not visible: @ghost",
  });
});

test.each([
  [
    "explicit zone",
    { timeZone: "Pacific/Kiritimati", observedTimeZone: "America/Los_Angeles" },
    "Pacific/Kiritimati",
  ],
  [
    "observed fallback",
    { timeZone: "Invalid/Zone", observedTimeZone: "America/Los_Angeles" },
    "America/Los_Angeles",
  ],
  ["invalid zones", { timeZone: "Invalid/Zone", observedTimeZone: "Invalid/Other" }, undefined],
  ["no preferences row", null, undefined],
] as const)("GET user info resolves a member's %s", async (_, preferences, timeZone) => {
  const response = await request("alice", preferences);
  expect(response.status).toBe(200);
  const { user } = await response.json();
  expect(user).toEqual({
    kind: "human",
    id: "user-alice",
    name: "alice",
    displayName: "Alice Chen",
    description: "",
    role: "member",
    isSelf: false,
    ...(timeZone ? { timeZone } : {}),
  });
});
