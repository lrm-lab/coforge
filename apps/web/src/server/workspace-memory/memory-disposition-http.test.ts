import { expect, test } from "bun:test";
import { handleMemoryDispositionHttp } from "./memory-disposition-http.server";
import { createMemorySourceAccess } from "#src/server/openviking/memory-source-access.server";
import type { OpenVikingGatewayResult } from "#src/server/openviking/policy-gateway.server";

test("source authorization uses the current target identity and distinguishes ACL denial from outage", async () => {
  const calls: unknown[] = [];
  let result: OpenVikingGatewayResult = {
    ok: true,
    response: { status: 200, headers: {}, body: new Blob([]).stream() },
  };
  const canRead = createMemorySourceAccess({
    bindings: {
      async get() {
        return { accountId: "account" };
      },
    },
    gateway: {
      async forward(actor, request) {
        calls.push({ actor, request });
        return result;
      },
    },
  });
  const source = { citationId: "source", accountId: "account", uri: "viking://resources/source" };
  expect(await canRead("workspace", "target", source)).toBe(true);
  expect(calls).toEqual([
    {
      actor: { kind: "agent", agentId: "target" },
      request: {
        workspaceId: "workspace",
        method: "GET",
        path: "/api/v1/fs/stat",
        query: { uri: source.uri },
      },
    },
  ]);
  result = { ok: true, response: { status: 403, headers: {}, body: new Blob([]).stream() } };
  expect(await canRead("workspace", "target", source)).toBe(false);
  result = { ok: true, response: { status: 503, headers: {}, body: new Blob([]).stream() } };
  await expect(canRead("workspace", "target", source)).rejects.toThrow(
    "authorization is unavailable",
  );
  expect(await canRead("workspace", "target", { ...source, accountId: "other" })).toBe(false);
  expect(calls).toHaveLength(3);
});

test("HTTP serialization preserves receipt and skipped refs, without a channel message", async () => {
  const record = {
    hint_id: "hint",
    target_agent_id: "target",
    decision: "adopt" as const,
    reason: "relevant",
    intended_action_refs: ["future-action"],
    decided_at: "2026-10-15T04:00:00Z",
    skipped_source_refs: ["private-source"],
  };
  const response = await handleMemoryDispositionHttp({
    db: {} as never,
    workspaceId: "workspace",
    agentId: "target",
    body: {},
    service: {
      async submit(workspace, agent) {
        expect([workspace, agent]).toEqual(["workspace", "target"]);
        return { ok: true, duplicate: false, record };
      },
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, duplicate: false, record });
});
