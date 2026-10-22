import {
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  decodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceFilesListResult,
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  decodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFileReadResult,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  decodeAgentWorkspaceDeleteRequest,
  encodeAgentWorkspaceDeleteResult,
  AGENT_WORKSPACE_DELETE_RESULT_METHOD,
} from "@lrm/coforge-sdk/internal";
import {
  decodePiChatRequest,
  encodePiChatFrame,
  PI_CHAT_FRAME_METHOD,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";

type Scope = { workspaceId: string; computerId: string };
type Rpc = (method: string, bytes: Uint8Array) => Promise<unknown>;

/** One replaceable query listener and its versioned reply codec on the existing socket. */
class DaemonQuery<Request extends Scope, Result> {
  #listener?: (request: Request) => Promise<void>;
  constructor(
    private readonly decode: (bytes: Uint8Array) => Request,
    private readonly encode: (value: Result) => Uint8Array,
    private readonly method: string,
    private readonly rpc: Rpc,
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
      return false;
    }
    if (request.workspaceId === scope.workspaceId && request.computerId === scope.computerId)
      void this.#listener?.(request).catch(() => {});
    return true;
  }
}

/** All scoped request/reply query transports share the daemon's single WSS client. */
export class DaemonQueries {
  readonly skills;
  readonly files;
  readonly file;
  readonly deletion;
  readonly piChat;
  constructor(rpc: Rpc) {
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
    this.piChat = new DaemonQuery(
      decodePiChatRequest,
      encodePiChatFrame,
      PI_CHAT_FRAME_METHOD,
      rpc,
    );
  }
  receive(bytes: Uint8Array, scope: Scope) {
    return [this.piChat, this.skills, this.files, this.file, this.deletion].some((query) =>
      query.receive(bytes, scope),
    );
  }
}
