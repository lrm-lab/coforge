import type { DaemonConnectionClient } from "./daemon-connection-client";
import type { DaemonQueries } from "./daemon-queries";

/** Exposes the query transport seams shared by the cloud connection and its handlers. */
export abstract class DaemonConnectionWorkspaceBindings implements Pick<
  DaemonConnectionClient,
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
  | "onLocalSessionSearch"
  | "sendLocalSessionSearchResult"
  | "onLocalSessionExcerpt"
  | "sendLocalSessionExcerptResult"
  | "onPiChatRequest"
  | "sendPiChatFrame"
> {
  protected abstract get daemonQueries(): DaemonQueries;

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
  get onLocalSessionSearch() {
    return this.daemonQueries.localSessionSearch.onRequest;
  }
  get sendLocalSessionSearchResult() {
    return this.daemonQueries.localSessionSearch.sendResult;
  }
  get onLocalSessionExcerpt() {
    return this.daemonQueries.localSessionExcerpt.onRequest;
  }
  get sendLocalSessionExcerptResult() {
    return this.daemonQueries.localSessionExcerpt.sendResult;
  }
  get onPiChatRequest() {
    return this.daemonQueries.piChat.onRequest;
  }
  get sendPiChatFrame() {
    return this.daemonQueries.piChat.sendResult;
  }
}
