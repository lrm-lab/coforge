import {
  decodeAgentMemoryRequest,
  encodeAgentMemoryResult,
  AGENT_MEMORY_RESULT_METHOD,
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  decodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceFilesListResult,
  decodeAgentWorkspaceScanRequest,
  encodeAgentWorkspaceScanResult,
  AGENT_WORKSPACE_SCAN_RESULT_METHOD,
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  decodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFileReadResult,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  decodeAgentWorkspaceDeleteRequest,
  encodeAgentWorkspaceDeleteResult,
  AGENT_WORKSPACE_DELETE_RESULT_METHOD,
  decodeAgentContextViewRequest,
  encodeAgentContextViewResult,
  isAgentContextViewRequest,
  AGENT_CONTEXT_VIEW_RESULT_METHOD,
  decodeAgentSideAskRequest,
  encodeAgentSideAskResult,
  isAgentSideAskRequest,
  AGENT_SIDE_ASK_RESULT_METHOD,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  decodePiChatRequest,
  encodePiChatFrame,
  PI_CHAT_FRAME_METHOD,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";

const logger = getLogger(["coforge", "daemon", "queries"]);

type Scope = { workspaceId: string; computerId: string };
type Rpc = (method: string, bytes: Uint8Array) => Promise<unknown>;

class DaemonQuery<Request extends Scope, Result> {
  #listener?: (request: Request) => Promise<void>;
  constructor(
    private readonly decode: (bytes: Uint8Array) => Request,
    private readonly encode: (value: Result) => Uint8Array,
    private readonly method: string,
    private readonly rpc: Rpc,
    private readonly onInvalid?: (bytes: Uint8Array) => void,
  ) {}
  readonly onRequest = (listener: (request: Request) => Promise<void>) => {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  };
  readonly sendResult = async (result: Result): Promise<void> => {
    await this.rpc(this.method, this.encode(result));
  };
  receive(bytes: Uint8Array, scope: Scope) {
    let request: Request;
    try {
      request = this.decode(bytes);
    } catch {
      this.onInvalid?.(bytes);
      return false;
    }
    if (request.workspaceId === scope.workspaceId && request.computerId === scope.computerId)
      void this.#listener?.(request).catch((error: unknown) => {
        logger.warning("Workspace query handler failed", {
          event: "workspace_query:handler_failed",
          workspace_id: request.workspaceId,
          computer_id: request.computerId,
          ...("requestId" in request && typeof request.requestId === "string"
            ? { request_id: request.requestId }
            : {}),
          error_code: error instanceof Error ? error.name : "unknown",
          outcome: "failed",
        });
      });
    return true;
  }
}

export class DaemonQueries {
  readonly memory;
  readonly skills;
  readonly files;
  readonly file;
  readonly scan;
  readonly deletion;
  readonly agentContextView;
  readonly agentSideAsk;
  readonly piChat;
  constructor(rpc: Rpc) {
    this.memory = new DaemonQuery(
      decodeAgentMemoryRequest,
      encodeAgentMemoryResult,
      AGENT_MEMORY_RESULT_METHOD,
      rpc,
    );
    this.skills = new DaemonQuery(
      decodeAgentSkillsListRequest,
      encodeAgentSkillsListResult,
      AGENT_SKILLS_LIST_RESULT_METHOD,
      rpc,
    );
    this.files = new DaemonQuery(
      decodeAgentWorkspaceFilesListRequest,
      encodeAgentWorkspaceFilesListResult,
      AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
      rpc,
    );
    this.scan = new DaemonQuery(
      decodeAgentWorkspaceScanRequest,
      encodeAgentWorkspaceScanResult,
      AGENT_WORKSPACE_SCAN_RESULT_METHOD,
      rpc,
    );
    this.file = new DaemonQuery(
      decodeAgentWorkspaceFileReadRequest,
      encodeAgentWorkspaceFileReadResult,
      AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
      rpc,
    );
    this.deletion = new DaemonQuery(
      decodeAgentWorkspaceDeleteRequest,
      encodeAgentWorkspaceDeleteResult,
      AGENT_WORKSPACE_DELETE_RESULT_METHOD,
      rpc,
    );
    this.agentContextView = new DaemonQuery(
      decodeAgentContextViewRequest,
      encodeAgentContextViewResult,
      AGENT_CONTEXT_VIEW_RESULT_METHOD,
      rpc,
      (bytes) => {
        if (!isAgentContextViewRequest(bytes)) return;
        logger.error("Agent context view request invalid", {
          event: "daemon.agent_context_view.request_invalid",
        });
      },
    );
    this.agentSideAsk = new DaemonQuery(
      decodeAgentSideAskRequest,
      encodeAgentSideAskResult,
      AGENT_SIDE_ASK_RESULT_METHOD,
      rpc,
      (bytes) => {
        if (!isAgentSideAskRequest(bytes)) return;
        logger.error("Agent side ask request invalid", {
          event: "daemon.agent_side_ask.request_invalid",
        });
      },
    );
    this.piChat = new DaemonQuery(
      decodePiChatRequest,
      encodePiChatFrame,
      PI_CHAT_FRAME_METHOD,
      rpc,
    );
  }
  receive(bytes: Uint8Array, scope: Scope) {
    return [
      this.piChat,
      this.memory,
      this.skills,
      this.files,
      this.scan,
      this.file,
      this.deletion,
      this.agentContextView,
      this.agentSideAsk,
    ].some((query) => query.receive(bytes, scope));
  }
}
