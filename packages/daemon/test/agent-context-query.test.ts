import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryAgentContext } from "#src/daemon-runtime/agent-context-query";
import { ContextViewRestoreCache } from "#src/agent-context-view/context-view-restore-cache";

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

test("Agent context queries reuse a short-lived restore and invalidate on source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-agent-context-cache-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, '{"sessionId":"session-current"}\n');
  await chmod(sourcePath, 0o600);
  const restoreCache = new ContextViewRestoreCache();
  let restores = 0;
  const request = {
    mode: "search" as const,
    messageId: "message-1",
    sessionId: "session-current",
    query: "secret",
  };
  const ports = {
    workspaceRoot: root,
    stateDirectory: root,
    currentSessionId: () => "session-current",
    contextViewEnabled: () => true,
    restoreCache,
    contextView: {
      find: () => ({
        messageId: "message-1",
        sentAt: "2026-01-01T00:00:00.000Z",
        runtime: "pi" as const,
        sessionId: "session-current",
        transcript: "session.jsonl",
        offset: 64,
      }),
    },
    restoreInChild: async () => {
      restores++;
      return {
        ok: true as const,
        view: {
          runtime: "pi" as const,
          sessionId: "session-current",
          messageId: "message-1",
          messages: [],
          source: { kind: "captured" as const, format: "pi" },
          redactions: { media: 0, diagnostic: 0 },
        },
      };
    },
  };
  try {
    await queryAgentContext(ports, "agent-1", request);
    await queryAgentContext(ports, "agent-1", request);
    expect(restores).toBe(1);
    await writeFile(sourcePath, '{"sessionId":"session-current"}\n\n');
    await queryAgentContext(ports, "agent-1", request);
    expect(restores).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
