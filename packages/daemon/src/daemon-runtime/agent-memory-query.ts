import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  encodeAgentMemoryResult,
  type AgentMemoryRequest,
  type AgentMemoryResult,
} from "@lrm/coforge-sdk/internal";
import { LocalMemory } from "#src/local-memory/local-memory";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import type { DaemonConfig } from "./runtime-connection-config";

export async function executeScopedMemoryRequest(
  connection: DaemonConfig,
  request: AgentMemoryRequest,
): Promise<AgentMemoryResult | undefined> {
  if (
    request.workspaceId !== connection.workspaceId ||
    request.computerId !== connection.computerId
  )
    return;
  const base = {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    computerId: request.computerId,
    agentId: request.agentId,
  };
  try {
    const root = agentWorkspaceDirectory(
      connection.workspaceRoot,
      connection.workspaceId,
      request.agentId,
    );
    for (const path of [dirname(dirname(root)), dirname(root), root]) {
      if (!(await lstat(path)).isDirectory()) throw new Error("memory_unsafe_path");
    }
    const result: AgentMemoryResult = {
      ...base,
      status: "ok",
      result: await new LocalMemory(root).execute(request.command),
    };
    try {
      encodeAgentMemoryResult(result);
    } catch {
      return { ...base, status: "failed", error: "unavailable" };
    }
    return result;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return {
      ...base,
      status: "failed",
      error:
        code === "memory_conflict"
          ? "conflict"
          : code === "memory_not_found" || missing
            ? "not_found"
            : "invalid",
    };
  }
}
