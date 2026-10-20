import { expect, test } from "bun:test";

import { AppError, type AppErrorCode } from "#src/lib/app-error";
import { handleAgentAppList } from "#src/routes/api/agent/v1/apps/index";
import { handleAgentAppToken } from "#src/routes/api/agent/v1/apps/$appId/token";
import {
  AgentAppUse,
  type AgentAppUsePorts,
} from "#src/server/app-agent-access/agent-app-use.server";
import type { AgentAccessOutcome } from "#src/server/app-agent-access/app-agent-access.server";
import { ISSUER, NOW, SIGNING_KEYS } from "./oidc-token-fixture";

/**
 * An Agent's use of its Workspace's apps without a database: how the Agent routes answer the
 * service's refusals, and a use whose waiting request a person decides while its approval card is
 * being posted. The store-backed flow is `agent-app-tokens.integration.test.ts`.
 */
const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const FIXED = ["openid", "profile", "identity"];

const tokenRequest = (body: unknown = {}) =>
  new Request("https://server.example/api/agent/v1/apps/acme-notes/token", {
    method: "POST",
    body: JSON.stringify(body),
  });

const refusing = (code: AppErrorCode) => async () => {
  throw new AppError(code);
};

test("the service's refusals reach the Agent as a coded error body, not a server error", async () => {
  const cases = [
    ["NOT_FOUND", 404, "not_found"],
    ["CONFLICT", 409, "conflict"],
    ["INVALID_INPUT", 400, "invalid_input"],
    ["ACCESS_DENIED", 403, "access_denied"],
  ] as const;
  for (const [code, status, errorCode] of cases) {
    const listed = await handleAgentAppList(principal, { list: refusing(code) });
    const token = await handleAgentAppToken(tokenRequest(), principal, "acme-notes", {
      token: refusing(code),
    });
    for (const response of [listed, token]) {
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        ok: false,
        errorCode,
        error: expect.any(String),
      });
    }
  }
  const broken = handleAgentAppList(principal, {
    list: async () => {
      throw new Error("database down");
    },
  });
  await expect(broken).rejects.toThrow("database down");
});

test("a token request body with anything but a target is refused", async () => {
  const response = await handleAgentAppToken(
    tokenRequest({ idempotencyKey: "k" }),
    principal,
    "acme-notes",
    { token: refusing("INTERNAL_ERROR") },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, errorCode: "request_invalid" });
});

/** An `AgentAppUse` whose access answers `outcomes` in turn, and whose card store says the
 * request was decided (`undefined`) or posts the card as `card-<request id>`. */
function use(outcomes: AgentAccessOutcome[], decided: Set<string>) {
  const posted: string[] = [];
  const ports: AgentAppUsePorts = {
    access: {
      listForAgent: async () => [],
      resolveAgentAccess: async () => outcomes.shift()!,
    },
    cards: {
      find: async () => undefined,
      post: async (_agent, _target, request) => {
        if (decided.has(request.id)) return undefined;
        posted.push(request.id);
        return `card-${request.id}`;
      },
    },
    issuer: () => ({ status: "ready", issuer: ISSUER, signingKeys: SIGNING_KEYS }),
    workspaceSlug: async () => "acme",
    now: () => NOW,
  };
  return { apps: new AgentAppUse(ports), posted };
}

const pending = (requestId: string): AgentAccessOutcome => ({
  status: "pending",
  requestId,
  scopes: FIXED,
  appName: "Acme Notes",
});

test("a request approved while its card was being posted answers a token, and posts no card", async () => {
  const { apps, posted } = use(
    [pending("r-1"), { status: "granted", scopes: FIXED, automatic: false }],
    new Set(["r-1"]),
  );
  const outcome = await apps.token(principal, "acme-notes", { target: "#ops" });
  expect(outcome).toMatchObject({
    status: "issued",
    audience: "acme-notes",
    scope: FIXED.join(" "),
  });
  expect(posted).toEqual([]);
});

test("a request denied while its card was being posted asks again with a new request", async () => {
  const { apps, posted } = use([pending("r-1"), pending("r-2")], new Set(["r-1"]));
  expect(await apps.token(principal, "acme-notes", { target: "#ops" })).toEqual({
    status: "approval_required",
    requestId: "r-2",
    actionCardMessageId: "card-r-2",
  });
  expect(posted).toEqual(["r-2"]);
});
