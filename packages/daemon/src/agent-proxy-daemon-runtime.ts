import type { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { AgentProxyRuntime } from "#src/agent-proxy-runtime";
import { attachmentRuntime } from "#src/agent-proxy-attachment-runtime";
import { mentionRuntime } from "#src/agent-proxy-mention-runtime";
import { conversationRuntime } from "#src/agent-proxy-conversation-runtime";
import { appRuntime } from "#src/agent-proxy-app-runtime";
import { workspaceRuntime } from "#src/agent-proxy-workspace-runtime";
export function daemonAgentProxyRuntime(
  requireRuntime: () => DaemonRuntime,
): Required<AgentProxyRuntime> {
  const agentApi = () => requireRuntime().agentRequests;
  const localQueries = () => requireRuntime().localQueries;
  return {
    agentMemory: async (...args) => requireRuntime().agentMemory(...args),
    agentContext: async (...args) => localQueries().context(...args),
    procList: async (...args) => localQueries().procList(...args),
    procStart: async (...args) => localQueries().procStart(...args),
    procLogs: async (...args) => localQueries().procLogs(...args),
    procStop: async (...args) => localQueries().procStop(...args),
    agentMessage: async (...args) => requireRuntime().agentMessage(...args),
    ...attachmentRuntime(agentApi),
    ...mentionRuntime(agentApi),
    ...conversationRuntime(agentApi),
    inbox: async (...args) => requireRuntime().inbox(...args),
    reminder: async (...args) => requireRuntime().reminder(...args),
    agentTask: async (...args) => requireRuntime().agentTask(...args),
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
    computerUpdateNotice: async (...args) => localQueries().computerUpdateNotice(...args),
    ...workspaceRuntime(agentApi),
    ...appRuntime(agentApi),
    agentTeamMemory: async (...args) => agentApi().agentTeamMemory(...args),
    agentArtifact: async (...args) => agentApi().agentArtifact(...args),
    agentArtifactUpload: async (context, request, key) =>
      agentApi().agentArtifact(context, { file: "upload", ...request }, key),
    agentArtifactDownload: async (context, request, key) =>
      agentApi().agentArtifact(context, { file: "download", ...request }, key),
    issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
  };
}
