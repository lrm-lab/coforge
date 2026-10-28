import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRequest, TaskRequest, TaskResponse } from "@lrm/coforge-sdk/internal";
import type {
  AgentMessageTransportResponse,
  AgentSendReconciliationRequest,
} from "#src/connection/agent-http-clients";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";
import { sessionSpy } from "./session-spy";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());

/**
 * Builds a `messageHarness` for one test file's Workspace: a runtime whose transport answers
 * messages, tasks, uploads and reconciliations through the given responders, and whose Agent
 * starts with a session that reports no output. Each harness reads its own state directory under
 * `tempRoot` unless the caller names one, so a test's seeded draft and cursor are the ones it
 * reads.
 */
export function createMessageHarness(fixtures: {
  connection: WorkspaceConfig;
  config: AgentRuntimeConfig;
}) {
  const { connection, config } = fixtures;
  return async function messageHarness(
    respond: (request: AgentMessageRequest) => Promise<AgentMessageTransportResponse>,
    respondTask?: (request: TaskRequest) => Promise<TaskResponse>,
    respondAttachmentUpload?: (request: Request, agentApiKey?: string) => Promise<Response>,
    respondUploadSessions?: {
      create?: (body: unknown, agentApiKey?: string) => Promise<Response>;
      complete?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
      cancel?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
      get?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
    },
    reconcile?: (
      request: AgentSendReconciliationRequest,
    ) => Promise<AgentSendReconciliationResponse>,
    stateDirectory = join(tempRoot, `coforge-harness-${crypto.randomUUID()}`),
  ) {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          agentMessage: respond,
          reconcileAgentSend: reconcile,
          agentTask: respondTask,
          agentAttachmentUpload: respondAttachmentUpload,
          agentAttachmentUploadSessionCreate: respondUploadSessions?.create,
          agentAttachmentUploadSessionComplete: respondUploadSessions?.complete,
          agentAttachmentUploadSessionCancel: respondUploadSessions?.cancel,
          agentAttachmentUploadSessionGet: respondUploadSessions?.get,
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    return {
      runtime,
      stateDirectory,
      context: runtime.issueAgentContext("agent-a"),
      apiKey: `sk_agent_${"a".repeat(43)}`,
      deliver: (sequence: number, target: string) =>
        runtime.handleAgentMessage({
          protocolMajor: 1,
          requestId: `delivery-${sequence}`,
          messageId: `message-${sequence}`,
          deliveryId: `delivery-${sequence}`,
          sequence,
          workspaceId: connection.workspaceId,
          conversationId: "conversation-a",
          agentId: "agent-a",
          body: `body-${sequence}`,
          method: "agent:v1:message:deliver",
          target,
        }),
    };
  };
}
