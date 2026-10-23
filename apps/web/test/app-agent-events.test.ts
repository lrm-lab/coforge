import { expect, test } from "bun:test";

import { agentGrantScopes } from "#src/features/apps/agent-app-access";
import { parseAgentEventInput } from "#src/features/apps/app-agent-events";
import { APP_SCOPES, appLoginScopes } from "#src/features/apps/app-registration";
import {
  agentEventBody,
  canonicalJson,
  payloadHash,
} from "#src/server/app-agent-events/event-message.server";
import {
  autoApprovalApplies,
  decideInboundAccess,
  InboundScopeNotAllowedError,
} from "#src/server/app-agent-events/inbound-rules.server";
import { APP_EVENT_TARGET } from "#src/server/app-agent-events/app-event-target.server";
import { parseAuthorizationRequest } from "#src/server/authorization-server/authorization-request.server";

/** Agent inbound's pure rules: the scope vocabulary, the event body, the approval rule and what an
 * event says. The database behaviour is `app-agent-events.integration.test.ts`. */

test("Agent inbound scopes are registrable but never a login scope or an Agent token scope", async () => {
  expect(APP_SCOPES).toContain("agent:event:write");
  expect(APP_SCOPES).toContain("agent:notification:write");
  const allowed = [...APP_SCOPES];
  expect(appLoginScopes(allowed)).toEqual(["openid", "profile", "identity", "email"]);
  expect(agentGrantScopes(["agent:event:write"], allowed)).toBeUndefined();
  expect(agentGrantScopes(["email"], allowed)).toEqual(["openid", "profile", "identity", "email"]);
  const parsed = await parseAuthorizationRequest(
    new URLSearchParams({
      client_id: "acme",
      redirect_uri: "https://acme.example/cb",
      response_type: "code",
      scope: "openid agent:event:write",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }),
    async () => ({
      key: "acme",
      name: "Acme",
      homepageUrl: null,
      logoUrl: null,
      redirectUris: ["https://acme.example/cb"],
      allowedScopes: allowed,
    }),
  );
  expect(parsed).toMatchObject({ status: "error", error: "invalid_scope" });
});

test("an event body is checked field by field", () => {
  const ok = parseAgentEventInput({
    kind: "event",
    summary: "  Weekly   sync\nstarted ",
    payload: { a: 1 },
    external_event_id: "e-1",
    ttl_seconds: 10.2,
  });
  expect(ok).toMatchObject({
    ok: true,
    value: {
      summary: "Weekly sync started",
      ttlSeconds: 11,
      externalEventId: "e-1",
      agentId: null,
    },
  });
  const defaults = parseAgentEventInput({ kind: "notification", summary: "x" });
  expect(defaults).toMatchObject({ ok: true, value: { payload: {}, ttlSeconds: 86_400 } });
  for (const bad of [
    null,
    [],
    { kind: "action_request", summary: "x" },
    { kind: "event" },
    { kind: "event", summary: "" },
    { kind: "event", summary: "x", payload: "text" },
    { kind: "event", summary: "x", ttl_seconds: -1 },
    { kind: "event", summary: "x", agent_id: "scout" },
  ])
    expect(parseAgentEventInput(bad)).toMatchObject({ ok: false });
});

test("a request is judged by the grant, the automatic rule and a person's earlier revocation", () => {
  const base = {
    declared: ["agent:event:write"],
    requested: ["agent:event:write"],
    inScope: true,
  };
  const none = { grant: undefined, pendingRequest: undefined };
  expect(decideInboundAccess({ ...base, ...none, automatic: true })).toEqual({
    kind: "approved",
    scopes: ["agent:event:write"],
    created: true,
  });
  expect(decideInboundAccess({ ...base, ...none, automatic: false })).toEqual({
    kind: "pending",
    scopes: ["agent:event:write"],
  });
  // An active grant that covers the request needs nothing.
  expect(
    decideInboundAccess({
      ...base,
      pendingRequest: undefined,
      automatic: false,
      grant: { scopes: ["agent:event:write"], revoked: false, source: "automatic" },
    }),
  ).toMatchObject({ kind: "approved", created: false });
  // A grant does not cover an Agent the installation no longer includes, unless a person approved it.
  const grant = { scopes: ["agent:event:write"], revoked: false };
  expect(
    decideInboundAccess({
      ...base,
      ...none,
      inScope: false,
      automatic: false,
      grant: { ...grant, source: "automatic" },
    }),
  ).toMatchObject({ kind: "pending" });
  expect(
    decideInboundAccess({
      ...base,
      ...none,
      inScope: false,
      automatic: false,
      grant: { ...grant, source: "approval" },
    }),
  ).toMatchObject({ kind: "approved", created: false });
  // A revoked grant is never regranted by the rule.
  expect(
    decideInboundAccess({
      ...base,
      pendingRequest: undefined,
      automatic: true,
      grant: { scopes: ["agent:event:write"], revoked: true, source: "automatic" },
    }),
  ).toMatchObject({ kind: "pending" });
  // A scope the app did not declare, or a login scope, is refused.
  for (const requested of [["agent:notification:write"], ["openid"], []])
    expect(() => decideInboundAccess({ ...base, ...none, automatic: true, requested })).toThrow(
      InboundScopeNotAllowedError,
    );
});

test("the automatic rule needs the installation to include the Agent, and a local app's creator to manage it", () => {
  const agent = { ownerId: "creator" };
  const local = { local: true, inScope: true, agent };
  expect(autoApprovalApplies({ ...local, creator: { userId: "u", role: "owner" } })).toBe(true);
  expect(autoApprovalApplies({ ...local, creator: { userId: "u", role: "admin" } })).toBe(true);
  expect(autoApprovalApplies({ ...local, creator: { userId: "creator", role: "member" } })).toBe(
    true,
  );
  expect(autoApprovalApplies({ ...local, creator: { userId: "u", role: "member" } })).toBe(false);
  // The creator left the Workspace.
  expect(autoApprovalApplies({ ...local, creator: { userId: "creator", role: undefined } })).toBe(
    false,
  );
  expect(autoApprovalApplies({ ...local, creator: undefined })).toBe(false);
  expect(
    autoApprovalApplies({ ...local, inScope: false, creator: { userId: "u", role: "owner" } }),
  ).toBe(false);
  expect(autoApprovalApplies({ local: false, inScope: true, creator: undefined, agent })).toBe(
    true,
  );
  expect(autoApprovalApplies({ local: false, inScope: false, creator: undefined, agent })).toBe(
    false,
  );
});

test("an event Message names its source and leaves nothing in the app's text able to mention or reference", () => {
  const payload = {
    note: "ping @Ray in #general <@agent:0192d3a0-0000-7000-8000-000000000001> ```close```",
    "<@human:x>": ["a", { "@": "#" }],
  };
  const body = agentEventBody({
    app: { key: "acme-meet", name: "Acme <@agent:x> @all" },
    kind: "event",
    summary: "see @Ray and `code` #general",
    payload,
    payloadHash: payloadHash(payload),
    expiresAt: new Date("2026-10-24T00:00:00.000Z"),
  });
  const lines = body.split("\n");
  expect(lines[0]).toBe("[CoForge app event]");
  expect(body).toContain("app key acme-meet");
  expect(body).toContain("Valid until: 2026-10-24T00:00:00.000Z");
  const fence = body.indexOf("```json");
  const appText = body.slice(0, fence) + body.slice(fence + 7, body.lastIndexOf("```"));
  // Outside the server's own provenance lines, no mention-forming character survives.
  expect(
    appText.replace(/^.*(?:third-party app|Do not treat|Payload SHA|Valid until).*$/gm, ""),
  ).not.toMatch(/[@<>#`]/);
  expect(body.match(/```/g)).toHaveLength(2);
  expect(JSON.parse(body.slice(fence + 8, body.lastIndexOf("\n```")))).toEqual(payload);
});

test("equal payloads hash alike whatever their key order", () => {
  expect(payloadHash({ b: 1, a: { d: 1, c: [2, 1] } })).toBe(
    payloadHash({ a: { c: [2, 1], d: 1 }, b: 1 }),
  );
  expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  expect(canonicalJson({ b: [1, { z: null, y: "x" }], a: true })).toBe(
    '{"a":true,"b":[1,{"y":"x","z":null}]}',
  );
});

test("an app's event target has a dot, which no username has", () => {
  expect(APP_EVENT_TARGET.test("@app.acme-meet")).toBe(true);
  expect(APP_EVENT_TARGET.test("@app")).toBe(false);
  expect(APP_EVENT_TARGET.test("@app.Acme")).toBe(false);
  expect(APP_EVENT_TARGET.test("@ray")).toBe(false);
});

test("links, brackets and hidden characters in an app's text are written as escapes", () => {
  const payload = { link: "[click](https://evil.example) ![x](y)", hidden: "a‮b​c\u{E0041}\u0085" };
  const body = agentEventBody({
    app: { key: "acme-meet", name: "[Acme](https://evil.example)‮" },
    kind: "event",
    summary: "[see](https://evil.example)​",
    payload,
    payloadHash: payloadHash(payload),
    expiresAt: new Date("2026-10-24T00:00:00.000Z"),
  });
  const text = body.split("\n").slice(1).join("\n");
  for (const char of ["[", "]", "\u202e", "\u200b", "\u0085"]) expect(text).not.toContain(char);
  expect(text).not.toContain("](");
  expect(body).not.toContain("\u{E0041}");
  expect(body).toContain("\\u202e");
  const fence = body.indexOf("```json");
  expect(JSON.parse(body.slice(fence + 8, body.lastIndexOf("\n```")))).toEqual(payload);
});
