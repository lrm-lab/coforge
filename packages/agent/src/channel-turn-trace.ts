import { OPENVIKING_AGENT_PROTOCOL, OPENVIKING_TOOL_NAMES } from "@lrm/coforge-sdk/agent";
import type { AgentTrainingStep } from "#src/training-trajectory";
import { exportAgentTrainingTrajectory } from "#src/training-trajectory";

/** One tool call an agent made before it sent a channel message. */
export type ChannelToolExchange = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
};

/** One channel message an agent sent, with what led up to it in the agent's own session. */
export type ChannelSendTrace = {
  messageId: string;
  /** Every tool call since the agent's previous send, in order, excluding the send itself. */
  toolExchanges: ChannelToolExchange[];
  /** Short ids (`msg=` tokens) of the messages `coforge message check|read` showed in that span. */
  receivedShortIds: string[];
};

export type AgentChannelTrace = {
  sessionId: string;
  sends: ChannelSendTrace[];
  /** Short ids the agent was shown after its last send (no later send to attach them to). */
  trailingReceivedShortIds: string[];
};

const SEND_COMMAND = /^\s*coforge\s+message\s+send\b/;
const READ_COMMAND = /^\s*coforge\s+message\s+(?:check|read)\b/;
const SHORT_ID = /\bmsg=([0-9a-f]{8}(?:-[0-9a-f]{0,4})?)/gi;
const MESSAGE_ID_TEXT = /Message ID:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;

function commandOf(step: Extract<AgentTrainingStep, { kind: "tool" }>): string {
  const input = step.input;
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
}

/** The id of the channel message a successful send-like tool call published, if any. */
function publishedMessageId(
  step: Extract<AgentTrainingStep, { kind: "tool" }>,
): string | undefined {
  if (step.isError) return undefined;
  if (
    (step.toolName === "bash" && SEND_COMMAND.test(commandOf(step))) ||
    step.toolName === "send_channel_message"
  ) {
    try {
      const receipt = JSON.parse(step.output.trim());
      if (
        (receipt?.accepted === true || receipt?.state === "sent") &&
        typeof receipt.messageId === "string" &&
        receipt.messageId
      )
        return receipt.messageId;
    } catch {
      return MESSAGE_ID_TEXT.exec(step.output)?.[1];
    }
    return undefined;
  }
  if (
    step.toolName === OPENVIKING_TOOL_NAMES.offer ||
    step.toolName === OPENVIKING_TOOL_NAMES.diagnose
  ) {
    try {
      const receipt = JSON.parse(step.output.trim());
      if (
        receipt?.protocol === OPENVIKING_AGENT_PROTOCOL &&
        receipt.published === true &&
        typeof receipt.messageId === "string" &&
        receipt.messageId
      )
        return receipt.messageId;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function shortIdsIn(output: string): string[] {
  return [...output.matchAll(SHORT_ID)].map((match) => match[1]!.toLowerCase());
}

/** Pure: group one agent's session steps into the span that ends at each channel send. */
export function channelTraceFromSteps(
  sessionId: string,
  steps: readonly AgentTrainingStep[],
): AgentChannelTrace {
  const sends: ChannelSendTrace[] = [];
  let exchanges: ChannelToolExchange[] = [];
  let received: string[] = [];
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    const messageId = publishedMessageId(step);
    if (messageId) {
      sends.push({ messageId, toolExchanges: exchanges, receivedShortIds: received });
      exchanges = [];
      received = [];
      continue;
    }
    exchanges.push({
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      input: step.input,
      output: step.output,
      isError: step.isError,
    });
    const reads =
      (step.toolName === "bash" && READ_COMMAND.test(commandOf(step))) ||
      step.toolName === "message_check" ||
      step.toolName === "message_read";
    if (reads && !step.isError) received.push(...shortIdsIn(step.output));
  }
  return { sessionId, sends, trailingReceivedShortIds: received };
}

/** Read one agent's runtime session and trace its channel sends. */
export async function exportAgentChannelTrace(input: {
  cwd: string;
  sessionId: string;
}): Promise<AgentChannelTrace> {
  const trajectory = await exportAgentTrainingTrajectory(input);
  return channelTraceFromSteps(trajectory.sessionId, trajectory.steps);
}
