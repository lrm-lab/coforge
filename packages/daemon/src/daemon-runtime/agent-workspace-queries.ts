import type {
  RuntimeProvider,
  AgentWorkspaceFilesListRequest,
  AgentWorkspaceFilesListResult,
  AgentWorkspaceScanRequest,
  AgentWorkspaceScanResult,
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "./runtime";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { listAgentSkills } from "#src/code-agent/agent-skills";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/agent-runtime/agent-workspace-files";
import {
  scanAgentWorkspaceDirectories,
  summarizeAgentWorkspaceDirectories,
} from "#src/agent-runtime/agent-workspace-scan";

/** Total concurrent browse/read observations this daemon may run across all Agents. */
export const WORKSPACE_FILES_SCAN_CONCURRENCY = 4;

/** Serialized, safe workspace observations, separate from runtime lifecycle and mutations. */
export class AgentWorkspaceQueries {
  #skillsScanning = false;
  #workspaceFilesScanning = new Set<string>();
  #workspaceFilesInFlight = 0;
  /** One budgeted statistics walk at a time: repeated requests share the running one. */
  #workspaceStatistics:
    | { agentsDirectory: string; promise: ReturnType<typeof summarizeAgentWorkspaceDirectories> }
    | undefined;
  constructor(private readonly provider: (agentId: string) => RuntimeProvider | undefined) {}

  async scan(
    connection: DaemonConfig,
    request: AgentWorkspaceScanRequest,
  ): Promise<Pick<AgentWorkspaceScanResult, "workspaces">> {
    const directory = agentsDirectory(connection.workspaceRoot, connection.workspaceId);
    const scan = request.withStatistics
      ? await this.#summarizeWorkspaceDirectories(directory)
      : await scanAgentWorkspaceDirectories({ agentsDirectory: directory });
    return { workspaces: scan.workspaces };
  }

  #summarizeWorkspaceDirectories(directory: string) {
    const running = this.#workspaceStatistics;
    if (running?.agentsDirectory === directory) return running.promise;
    const promise = summarizeAgentWorkspaceDirectories({ agentsDirectory: directory }).finally(
      () => {
        if (this.#workspaceStatistics?.promise === promise) this.#workspaceStatistics = undefined;
      },
    );
    this.#workspaceStatistics = { agentsDirectory: directory, promise };
    return promise;
  }
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
    if (
      this.#workspaceFilesScanning.has(request.agentId) ||
      this.#workspaceFilesInFlight >= WORKSPACE_FILES_SCAN_CONCURRENCY
    )
      return unavailable;
    this.#workspaceFilesScanning.add(request.agentId);
    this.#workspaceFilesInFlight += 1;
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
      this.#workspaceFilesScanning.delete(request.agentId);
      this.#workspaceFilesInFlight -= 1;
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
    if (
      this.#workspaceFilesScanning.has(request.agentId) ||
      this.#workspaceFilesInFlight >= WORKSPACE_FILES_SCAN_CONCURRENCY
    )
      return unavailable;
    this.#workspaceFilesScanning.add(request.agentId);
    this.#workspaceFilesInFlight += 1;
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
      this.#workspaceFilesScanning.delete(request.agentId);
      this.#workspaceFilesInFlight -= 1;
    }
  }
}
