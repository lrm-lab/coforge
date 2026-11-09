import { describe, expect, test } from "bun:test";
import { agentContextViewResultMatchesPrincipal } from "#src/server/agents/agent-context-view-result-http.server";

const principal = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
};
const result = {
  requestId: "ctxv_1234567890123456",
  workspaceId: principal.workspaceId,
  computerId: principal.computerId,
  agentId: principal.agentId,
};

describe("Agent context view result HTTP scope", () => {
  test("accepts a result only when request and all three scopes match", () => {
    expect(agentContextViewResultMatchesPrincipal(result, result.requestId, principal)).toBe(true);
  });

  test("rejects a result for another request, workspace, Computer, or Agent", () => {
    expect(agentContextViewResultMatchesPrincipal(result, "ctxv_other", principal)).toBe(false);
    for (const field of ["workspaceId", "computerId", "agentId"] as const) {
      expect(
        agentContextViewResultMatchesPrincipal(
          { ...result, [field]: `${result[field]}-other` },
          result.requestId,
          principal,
        ),
      ).toBe(false);
    }
  });
});
