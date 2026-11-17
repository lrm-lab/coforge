import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { executeScopedMemoryRequest } from "#src/daemon-runtime/agent-memory-query";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const id = "00000000-0000-4000-8000-000000000001";
test("owner memory requests stay on their Workspace Computer and preserve CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-owner-memory-"));
  roots.push(root);
  const connection = { workspaceId: id, computerId: id, workspaceRoot: root };
  await mkdir(agentWorkspaceDirectory(root, id, id), { recursive: true });
  const scope = { workspaceId: id, computerId: id, agentId: id, requestId: id };
  expect(
    await executeScopedMemoryRequest(connection, {
      ...scope,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      command: { operation: "list" },
    }),
  ).toBeUndefined();
  const saved = await executeScopedMemoryRequest(connection, {
    ...scope,
    command: {
      operation: "save",
      key: "decision",
      revision: "new",
      title: "Decision",
      content: "Confirmed",
      source: "Owner",
      kind: "decision",
      applicability: "",
    },
  });
  expect(saved?.status).toBe("ok");
  const stale = await executeScopedMemoryRequest(connection, {
    ...scope,
    command: {
      operation: "save",
      key: "decision",
      revision: "new",
      title: "Decision",
      content: "Overwritten",
      source: "Owner",
      kind: "decision",
      applicability: "",
    },
  });
  expect(stale).toMatchObject({ status: "failed", error: "conflict" });
  const read = await executeScopedMemoryRequest(connection, {
    ...scope,
    command: { operation: "get", key: "decision" },
  });
  expect(read?.status === "ok" && read.result.entries[0]?.content).toBe("Confirmed");
});

test("personal memory RPC never follows a linked Agent root", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-owner-linked-"));
  roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), "coforge-owner-private-"));
  roots.push(outside);
  const agentRoot = agentWorkspaceDirectory(root, id, id);
  await mkdir(join(agentRoot, ".."), { recursive: true });
  await symlink(outside, agentRoot);
  const result = await executeScopedMemoryRequest(
    { workspaceRoot: root, workspaceId: id, computerId: id },
    { workspaceId: id, computerId: id, agentId: id, requestId: id, command: { operation: "list" } },
  );
  expect(result).toMatchObject({ status: "failed", error: "invalid" });
});
