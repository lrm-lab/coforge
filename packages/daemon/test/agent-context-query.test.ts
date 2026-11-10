import { expect, test } from "bun:test";
import { queryAgentContext } from "#src/daemon-runtime/agent-context-query";

test("context query rejects stale sessions before looking up the retained message", async () => {
  let lookedUp = false;
  await expect(
    queryAgentContext(
      {
        workspaceRoot: "/tmp/workspace",
        stateDirectory: "/tmp/state",
        currentSessionId: () => "session-current",
        contextView: {
          find: () => {
            lookedUp = true;
            return undefined;
          },
        },
      },
      "agent-1",
      {
        mode: "search",
        messageId: "message-1",
        sessionId: "session-old",
        query: "secret",
      },
    ),
  ).rejects.toMatchObject({ code: "CONTEXT_SESSION_MISMATCH" });
  expect(lookedUp).toBe(false);
});
