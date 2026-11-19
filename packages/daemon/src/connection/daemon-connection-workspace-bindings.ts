import type { DaemonConnectionClient } from "./daemon-connection-client";
import type { DaemonQueries } from "./daemon-queries";

/** Exposes the query transport seams shared by the cloud connection and its handlers. */
export abstract class DaemonConnectionWorkspaceBindings implements Pick<
  DaemonConnectionClient,
  | "onAgentMemory"
  | "sendAgentMemoryResult"
  | "onSkillsList"
  | "sendSkillsListResult"
  | "onWorkspaceFilesList"
  | "sendWorkspaceFilesListResult"
  | "onWorkspaceScan"
  | "sendWorkspaceScanResult"
  | "onWorkspaceFileRead"
  | "sendWorkspaceFileReadResult"
  | "onWorkspaceDelete"
  | "sendWorkspaceDeleteResult"
  | "onAgentContextView"
  | "onAgentSideAsk"
  | "sendAgentSideAskResult"
  | "onRuntimeManage"
  | "sendRuntimeManageResult"
  | "onPiChatRequest"
  | "sendPiChatFrame"
> {
  protected abstract get daemonQueries(): DaemonQueries;

  get onAgentMemory() {
    return this.daemonQueries.memory.onRequest;
  }
  get sendAgentMemoryResult() {
    return this.daemonQueries.memory.sendResult;
  }

  get onSkillsList() {
    return this.daemonQueries.skills.onRequest;
  }
  get sendSkillsListResult() {
    return this.daemonQueries.skills.sendResult;
  }
  get onWorkspaceFilesList() {
    return this.daemonQueries.files.onRequest;
  }
  get sendWorkspaceFilesListResult() {
    return this.daemonQueries.files.sendResult;
  }
  get onWorkspaceScan() {
    return this.daemonQueries.scan.onRequest;
  }
  get sendWorkspaceScanResult() {
    return this.daemonQueries.scan.sendResult;
  }
  get onWorkspaceFileRead() {
    return this.daemonQueries.file.onRequest;
  }
  get sendWorkspaceFileReadResult() {
    return this.daemonQueries.file.sendResult;
  }
  get onWorkspaceDelete() {
    return this.daemonQueries.deletion.onRequest;
  }
  get sendWorkspaceDeleteResult() {
    return this.daemonQueries.deletion.sendResult;
  }
  get onAgentContextView() {
    return this.daemonQueries.agentContextView.onRequest;
  }
  get onAgentSideAsk() {
    return this.daemonQueries.agentSideAsk.onRequest;
  }
  get sendAgentSideAskResult() {
    return this.daemonQueries.agentSideAsk.sendResult;
  }
  get onRuntimeManage() {
    return this.daemonQueries.runtimeManage.onRequest;
  }
  get sendRuntimeManageResult() {
    return this.daemonQueries.runtimeManage.sendResult;
  }
  get onPiChatRequest() {
    return this.daemonQueries.piChat.onRequest;
  }
  get sendPiChatFrame() {
    return this.daemonQueries.piChat.sendResult;
  }
}
