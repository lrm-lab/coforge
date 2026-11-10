import { describe, expect, test } from "bun:test";
import {
  authorizeAgentContextSession,
  type AgentContextSessionScope,
} from "#src/agent-context-view/context-view-access";

const scope: AgentContextSessionScope = {
  authorizedAgentId: "agent-1",
  requestedAgentId: "agent-1",
  requestedSessionId: "session-1",
  currentSessionId: "session-1",
};

describe("Agent context session authorization", () => {
  test("accepts the token-bound Agent's current session", () => {
    expect(authorizeAgentContextSession(scope)).toEqual({ ok: true });
  });

  test("rejects a request that names another Agent before reading session state", () => {
    expect(authorizeAgentContextSession({ ...scope, requestedAgentId: "agent-2" })).toEqual({
      ok: false,
      reason: "agent_mismatch",
    });
  });

  test("rejects missing or stale sessions", () => {
    expect(authorizeAgentContextSession({ ...scope, currentSessionId: undefined })).toEqual({
      ok: false,
      reason: "session_unavailable",
    });
    expect(authorizeAgentContextSession({ ...scope, requestedSessionId: "session-old" })).toEqual({
      ok: false,
      reason: "session_mismatch",
    });
  });
});
