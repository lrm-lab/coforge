import type {
  RuntimeProvider,
  AgentWorkspaceFilesListRequest,
  AgentWorkspaceFilesListResult,
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "./runtime";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { listAgentSkills } from "#src/code-agent/agent-skills";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/agent-runtime/agent-workspace-files";

/** Serialized, safe workspace observations, separate from runtime lifecycle and mutations. */
export class AgentWorkspaceQueries {
  #skillsScanning = false;
  #workspaceFilesScanning = false;
  constructor(private readonly provider: (agentId: string) => RuntimeProvider | undefined) {}
  async listSkills(
    connection: DaemonConfig,
    request: { agentId: string; provider: RuntimeProvider },
  ): Promise<Awaited<ReturnType<typeof listAgentSkills>>> {
    const unavailable = { status: "error" as const, entries: [], directories: [] };
    const provider = this.provider(request.agentId);
    if (this.#skillsScanning || (provider && provider !== request.provider))
      return { global: unavailable, workspace: unavailable };
    this.#skillsScanning = true;
    try {
      // Launch only adds COFORGE_* capabilities to agentEnvironment;
      // it does not override HOME or provider-native config roots.
      return await listAgentSkills({
        provider: request.provider,
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return { global: unavailable, workspace: unavailable };
    } finally {
      this.#skillsScanning = false;
    }
  }

  async listFiles(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceFilesListRequest, "agentId" | "dirPath" | "includeHidden">,
  ): Promise<Pick<AgentWorkspaceFilesListResult, "status" | "rootPath" | "entries">> {
    const unavailable = { status: "error" as const, rootPath: "", entries: [] };
    if (this.#workspaceFilesScanning) return unavailable;
    this.#workspaceFilesScanning = true;
    try {
      return await listAgentWorkspaceFiles({
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
        dirPath: request.dirPath,
        includeHidden: request.includeHidden,
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return unavailable;
    } finally {
      this.#workspaceFilesScanning = false;
    }
  }

  async readFile(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceFileReadRequest, "agentId" | "path">,
  ): Promise<
    Pick<
      AgentWorkspaceFileReadResult,
      "status" | "sizeBytes" | "modifiedAtMs" | "text" | "contentType" | "contentBase64"
    >
  > {
    const unavailable = {
      status: "error" as const,
      sizeBytes: 0,
      modifiedAtMs: 0,
      text: "",
      contentType: "",
      contentBase64: "",
    };
    if (this.#workspaceFilesScanning) return unavailable;
    this.#workspaceFilesScanning = true;
    try {
      return await readAgentWorkspaceFile({
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
        path: request.path,
      });
    } catch {
      // Return safe diagnostics, never file contents or raw filesystem errors.
      return unavailable;
    } finally {
      this.#workspaceFilesScanning = false;
    }
  }
}
