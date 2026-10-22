import {
  exportAgentChannelTrace,
  type AgentChannelTrace,
} from "../../../packages/agent/src/channel-turn-trace.ts";
import type {
  AgentAttentionDecisionRecord,
  AgentAttentionDecisionPort,
} from "../../../packages/daemon/src/persistence/agent-attention-decision-store";
import type { TurnEnrichment } from "../../../apps/web/src/server/workspace-memory/dispatch";
import type { OpenVikingOutcomeEvaluatorResult } from "../../../apps/web/src/server/openviking/typed-session-extract.server";

const SHORT_ID_LENGTH = 13;

export type EnrichmentAgent = {
  id: string;
  /** The handle the sink uses for the agent's peer id (`coforge__<name>`). */
  name: string;
  trace: AgentChannelTrace | null;
  decisions: readonly AgentAttentionDecisionRecord[];
};

export type EnrichmentMessage = { id: string; senderAgentId: string | null };

const NOTIFIED = new Set(["notified", "already_notified"]);

/**
 * Pure. For every channel message, the tool calls its sender made before it (cycle 006 D-002)
 * and, for each other agent, whether the daemon notified it and whether it read the message
 * (cycle 007 D-004). A message with neither carries no entry.
 */
export function deriveTurnEnrichment(input: {
  agents: readonly EnrichmentAgent[];
  messages: readonly EnrichmentMessage[];
}): Map<string, TurnEnrichment> {
  const result = new Map<string, TurnEnrichment>();
  const entry = (id: string) => {
    let value = result.get(id);
    if (!value) {
      value = {};
      result.set(id, value);
    }
    return value;
  };
  const byShortId = new Map<string, string>();
  for (const message of input.messages)
    byShortId.set(message.id.slice(0, SHORT_ID_LENGTH).toLowerCase(), message.id);
  const known = new Set(input.messages.map((message) => message.id));

  const readBy = new Map<string, Set<string>>();
  const notifiedBy = new Map<string, Set<string>>();
  for (const agent of input.agents) {
    const read = new Set<string>();
    for (const short of [
      ...(agent.trace?.sends.flatMap((send) => send.receivedShortIds) ?? []),
      ...(agent.trace?.trailingReceivedShortIds ?? []),
    ]) {
      const id = byShortId.get(short.slice(0, SHORT_ID_LENGTH).toLowerCase());
      if (id) read.add(id);
    }
    readBy.set(agent.id, read);
    notifiedBy.set(
      agent.id,
      new Set(
        agent.decisions
          .filter((row) => NOTIFIED.has(row.outcome) && known.has(row.messageId))
          .map((row) => row.messageId),
      ),
    );
    for (const send of agent.trace?.sends ?? []) {
      if (known.has(send.messageId) && send.toolExchanges.length > 0)
        entry(send.messageId).toolExchanges = send.toolExchanges;
    }
  }
  for (const message of input.messages) {
    const deliveries = input.agents
      .filter((agent) => agent.id !== message.senderAgentId)
      .map((agent) => ({
        participantId: `coforge__${agent.name}`,
        notified: notifiedBy.get(agent.id)?.has(message.id) === true,
        read: readBy.get(agent.id)?.has(message.id) === true,
      }))
      .filter((item) => item.notified || item.read);
    if (deliveries.length > 0) entry(message.id).deliveries = deliveries;
  }
  return result;
}

/** Reads each agent's runtime session and attention journal. A missing session is not fatal. */
export async function loadEnrichmentAgents(input: {
  agents: ReadonlyArray<{ id: string; name: string; cwd: string; sessionId: string | null }>;
  decisions: AgentAttentionDecisionPort;
  warn?: (message: string) => void;
}): Promise<EnrichmentAgent[]> {
  const loaded: EnrichmentAgent[] = [];
  for (const agent of input.agents) {
    let trace: AgentChannelTrace | null = null;
    if (agent.sessionId) {
      try {
        trace = await exportAgentChannelTrace({ cwd: agent.cwd, sessionId: agent.sessionId });
      } catch (error) {
        input.warn?.(`agent ${agent.name} session trace unavailable: ${String(error)}`);
      }
    }
    loaded.push({
      id: agent.id,
      name: agent.name,
      trace,
      decisions: input.decisions.read(agent.id),
    });
  }
  return loaded;
}

export type SidecarVerdict = {
  reward?: number;
  graded?: boolean;
  error?: string | null;
  /** The judge report (optional). */
  feedback?: string;
};

export const FEEDBACK_LIMIT = 6000;

/**
 * The evaluator verdict OpenViking commits with (ADR-0047 D-007). None when the grader did not
 * finish (`graded` false) or gave no reward: an ungraded run carries no signal.
 */
export function evaluatorResultFromVerdict(input: {
  episodeId: string;
  verdict: SidecarVerdict;
  passReward: number;
}): OpenVikingOutcomeEvaluatorResult[] {
  const { verdict } = input;
  if (verdict.graded !== true || typeof verdict.reward !== "number") return [];
  if (!(verdict.reward >= 0 && verdict.reward <= 1)) return [];
  const feedback = typeof verdict.feedback === "string" ? verdict.feedback.trim() : "";
  return [
    {
      bindingId: `eval:${input.episodeId}`,
      signalKind: "evaluator",
      signal: verdict.reward >= input.passReward ? "pass" : "fail",
      evidenceRef: `sidecar-verify:${input.episodeId}`,
      reward: verdict.reward,
      ...(feedback ? { feedback: feedback.slice(0, FEEDBACK_LIMIT) } : {}),
    },
  ];
}
