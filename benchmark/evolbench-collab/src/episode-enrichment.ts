import { join } from "node:path";
import { AgentAttentionDecisionStore } from "../../../packages/daemon/src/persistence/agent-attention-decision-store";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import { deriveTurnEnrichment, loadEnrichmentAgents } from "./enrichment";
import { listSessionIds } from "./session-ids";
import type { EvalWorkspace } from "./workspace";

/** Tool exchanges and delivery facts for the episode's channel messages, read from both agents. */
export async function episodeEnrichment(
  workspace: EvalWorkspace,
  daemonWorkspaceRoot: string,
  taskTraceFromFile = false,
) {
  const agentRows = await workspace.db.agent.findMany({
    where: { id: { in: [workspace.memoryAgentId, workspace.taskAgentId] } },
    select: { id: true, name: true },
  });
  const agents = await loadEnrichmentAgents({
    agents: await Promise.all(
      agentRows.map(async (row) => {
        const cwd = join(daemonWorkspaceRoot, workspace.workspaceId, "agents", row.id);
        return { id: row.id, name: row.name, cwd, sessionIds: await listSessionIds(cwd) };
      }),
    ),
    decisions: new AgentAttentionDecisionStore(),
    taskTraceFromFile,
    warn: (message) => console.warn(sanitizeDiagnostic(message)),
  });
  const messages = await workspace.db.message.findMany({
    where: { conversationId: workspace.channelId },
    select: { id: true, sender: { select: { agentId: true } } },
    ...(taskTraceFromFile ? { orderBy: { sequence: "asc" as const } } : {}),
  });
  return deriveTurnEnrichment({
    agents,
    messages: messages.map((row) => ({ id: row.id, senderAgentId: row.sender?.agentId ?? null })),
  });
}
