import type { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { AgentProxyRuntime } from "#src/agent-proxy-runtime";
import { attachmentRuntime } from "#src/agent-proxy-attachment-runtime";
import { mentionRuntime } from "#src/agent-proxy-mention-runtime";
import { conversationRuntime } from "#src/agent-proxy-conversation-runtime";
import { appRuntime } from "#src/agent-proxy-app-runtime";
import { workspaceRuntime } from "#src/agent-proxy-workspace-runtime";

/**
 * The `AgentProxyRuntime` the local Agent proxy serves, bound to the Workspace runtime that
 * `runDaemon` may not have started yet: every member resolves it lazily, so a proxy call before
 * `runtime` exists rejects instead of throwing synchronously (every caller awaits inside a try).
 */
export function daemonAgentProxyRuntime(
  requireRuntime: () => DaemonRuntime,
): Required<AgentProxyRuntime> {
  const agentApi = () => requireRuntime().agentRequests;
  // Every caller awaits inside a try, so a missing runtime surfaces as a rejected call.
  return {
    agentContext: async (...args) => requireRuntime().agentContext(...args),
    agentMessage: async (...args) => requireRuntime().agentMessage(...args),
    ...attachmentRuntime(agentApi),
    ...mentionRuntime(agentApi),
    ...conversationRuntime(agentApi),
    inbox: async (...args) => requireRuntime().inbox(...args),
    reminder: async (...args) => requireRuntime().reminder(...args),
    agentTask: async (...args) => requireRuntime().agentTask(...args),
    agentMemoryDisposition: async (...args) => agentApi().agentMemoryDisposition(...args),
    agentOpenviking: async (...args) => agentApi().agentOpenviking(...args),
    memoryFence: (agentId) => requireRuntime().memoryFence(agentId),
    agentChannel: async (...args) => agentApi().agentChannel(...args),
    agentActionPrepare: async (...args) => agentApi().agentActionPrepare(...args),
    agentWeeklyReport: async (...args) => agentApi().agentWeeklyReport(...args),
    agentWeeklyReportCollect: async (...args) => agentApi().agentWeeklyReportCollect(...args),
    agentWeeklyReportKeyPoints: async (...args) => agentApi().agentWeeklyReportKeyPoints(...args),
    agentWeeklyReportMemory: async (...args) => agentApi().agentWeeklyReportMemory(...args),
    workspaceInfo: async (...args) => agentApi().workspaceInfo(...args),
    githubCredential: async (...args) => agentApi().githubCredential(...args),
    githubCommitTrailers: async (...args) => agentApi().githubCommitTrailers(...args),
    version: async (...args) => requireRuntime().version(...args),
    computerUpdateNotice: async (...args) => requireRuntime().computerUpdateNotice(...args),
    ...workspaceRuntime(agentApi),
    ...appRuntime(agentApi),
    agentArtifact: async (...args) => agentApi().agentArtifact(...args),
    issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
    // Every proxy route must reach the runtime here: an unwired handler is a 404 for the
    // Agent's CLI, so a new `AgentProxyRuntime` member fails to compile until it is added.
  };
}
