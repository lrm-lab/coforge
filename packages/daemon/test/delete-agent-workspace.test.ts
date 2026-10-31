import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAgentWorkspace } from "#src/daemon-runtime/delete-agent-workspace";
import { captureDaemonLogs } from "./log-capture";

// macOS tmpdir lives under /var, a symlink the workspace safety check refuses.
const tempRoot = realpathSync(tmpdir());

/** Whether the path exists at all: `Bun.file` only answers for files, and a workspace is a dir. */
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("a workspace is deleted after its Agent is stopped and forgotten", async () => {
  const root = await mkdtemp(join(tempRoot, "delete-workspace-"));
  const forgotten: string[] = [];
  try {
    await mkdir(join(root, "sub"));
    const result = await deleteAgentWorkspace({
      agentId: "agent-a",
      agentWorkspaceDirectory: root,
      isRunning: () => true,
      stopAgent: async () => undefined,
      forget: (agentId) => forgotten.push(agentId),
    });
    expect(result.status).toBe("ok");
    expect(forgotten).toEqual(["agent-a"]);
    expect(await exists(root)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Agent that will not stop is busy, and the failure is logged with its id", async () => {
  const root = await mkdtemp(join(tempRoot, "delete-workspace-busy-"));
  try {
    await mkdir(join(root, "sub"));
    const { result, records } = await captureDaemonLogs(() =>
      deleteAgentWorkspace({
        agentId: "agent-b",
        agentWorkspaceDirectory: root,
        isRunning: () => true,
        stopAgent: async () => {
          // A stop that times out carries no errno, and is still busy, not a generic failure.
          throw new Error("stop timed out");
        },
        forget: () => undefined,
      }),
    );
    expect(result.status).toBe("busy");
    // The workspace stayed: the failure is not reported as a deletion.
    expect(await exists(root)).toBe(true);
    const failure = records.find((record) => record.properties.event === "workspace_delete:failed");
    expect(failure?.properties).toMatchObject({ status: "busy", agent_id: "agent-b" });
    expect(failure?.properties.error_code).toBe("UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
