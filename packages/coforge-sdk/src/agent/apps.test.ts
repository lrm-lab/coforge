import { expect, test } from "bun:test";

import {
  decodeAgentAppErrorResponse,
  decodeAgentAppListResponse,
  decodeAgentAppTokenBody,
  decodeAgentAppTokenResponse,
} from "./apps";
import { agentApiRoutes } from "./routes";
import type { AgentAppView } from "./apps";

const notes = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "Notes.",
  whenToUse: "Read notes.",
  homepageUrl: null,
  builtIn: false,
  access: "granted",
};

test("the app routes are the same under proxy, local and cloud", () => {
  for (const routes of [agentApiRoutes.proxy, agentApiRoutes.local, agentApiRoutes.cloud]) {
    expect(routes.apps.list).toEqual({ method: "GET", path: "/api/agent/v1/apps" });
    expect(routes.apps.token.method).toBe("POST");
    expect(routes.apps.token.path("acme notes")).toBe("/api/agent/v1/apps/acme%20notes/token");
  }
});

test("a list names each app, a built-in one without an access state", () => {
  const builtIn = { ...notes, key: "system.cleaner", builtIn: true, access: undefined };
  const { access: _access, ...plain } = builtIn;
  expect(decodeAgentAppListResponse({ ok: true, apps: [notes, builtIn] })).toEqual({
    ok: true,
    apps: [notes as AgentAppView, plain],
  });
  const [decoded] = decodeAgentAppListResponse({ ok: true, apps: [builtIn] }).apps;
  expect(Object.hasOwn(decoded!, "access")).toBe(false);
  for (const apps of [[{ ...notes, access: "maybe" }], [{ ...notes, homepageUrl: 3 }], "x"])
    expect(() => decodeAgentAppListResponse({ ok: true, apps })).toThrow();
});

test("a list carries an app's Agent manifest location and its source, or neither", () => {
  const explicit = {
    ...notes,
    agentManifestUrl: "https://acme.example/m.json",
    agentManifestUrlSource: "explicit",
  };
  const none = { ...notes, key: "acme-none", agentManifestUrl: null, agentManifestUrlSource: null };
  expect(decodeAgentAppListResponse({ ok: true, apps: [explicit, none, notes] }).apps).toEqual([
    explicit,
    none,
    notes,
  ] as AgentAppView[]);
  const [plain] = decodeAgentAppListResponse({ ok: true, apps: [notes] }).apps;
  expect(Object.hasOwn(plain!, "agentManifestUrl")).toBe(false);
  for (const change of [
    { agentManifestUrl: 3 },
    { agentManifestUrl: "https://a.example/", agentManifestUrlSource: "guess" },
  ])
    expect(() =>
      decodeAgentAppListResponse({ ok: true, apps: [{ ...notes, ...change }] }),
    ).toThrow();
});

test("a token answer is a token, a wait for approval, or no such app", () => {
  const issued = {
    ok: true,
    status: "issued",
    access_token: "a.b.c",
    token_type: "Bearer",
    expires_in: 300,
    audience: "acme-notes",
    scope: "openid",
  } as const;
  expect(decodeAgentAppTokenResponse(issued)).toEqual(issued);
  const waiting = { ok: true, status: "approval_required", requestId: "r-1" } as const;
  expect(decodeAgentAppTokenResponse(waiting)).toEqual(waiting);
  const carded = { ...waiting, actionCardMessageId: "m-1" };
  expect(decodeAgentAppTokenResponse({ ...carded, extra: 1 })).toEqual(carded);
  expect(decodeAgentAppTokenResponse({ ok: true, status: "not_installed" })).toEqual({
    ok: true,
    status: "not_installed",
  });
  for (const value of [{ ...issued, access_token: "" }, { ok: true, status: "other" }, null])
    expect(() => decodeAgentAppTokenResponse(value)).toThrow();
});

test("a token request body holds at most a target, and nothing else", () => {
  expect(decodeAgentAppTokenBody({})).toEqual({});
  expect(decodeAgentAppTokenBody({ target: "#ops" })).toEqual({ target: "#ops" });
  for (const value of [
    { target: "" },
    { target: "#".repeat(201) },
    { idempotencyKey: "k" },
    { target: "#ops", scope: "email" },
    [],
    null,
  ])
    expect(decodeAgentAppTokenBody(value)).toBeUndefined();
});

test("an app refusal names one of the app error codes", () => {
  const refusal = { ok: false, errorCode: "target_invalid", error: "no" } as const;
  expect(decodeAgentAppErrorResponse(refusal)).toEqual(refusal);
  expect(decodeAgentAppErrorResponse({ ...refusal, errorCode: "other" })).toBeUndefined();
  for (const errorCode of ["not_found", "conflict", "invalid_input", "access_denied"] as const)
    expect(decodeAgentAppErrorResponse({ ...refusal, errorCode })).toEqual({
      ...refusal,
      errorCode,
    });
});
