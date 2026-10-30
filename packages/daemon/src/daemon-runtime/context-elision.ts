import {
  RUNTIME_PROVIDER,
  type AgentMessageRecord,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentContexts } from "./agent-contexts";
import type { AgentContextLedger } from "#src/persistence/agent-context-ledger";

/** The runtimes whose adapters report a finished compaction. For any other the daemon cannot tell
 * when the Agent's context was cut, so it never leaves anything out. */
const COMPACTION_REPORTING_RUNTIMES: ReadonlySet<string> = new Set<RuntimeProvider>([
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.PI,
]);

export function reportsCompaction(runtime: string): boolean {
  return COMPACTION_REPORTING_RUNTIMES.has(runtime);
}

/** The channel a target belongs to: `#name` for the channel and for any thread in it. */
function channelOf(target: string): string | undefined {
  return target.startsWith("#") ? target.split(":")[0] : undefined;
}

/**
 * The messages as the Agent should read them in its current context: a sender's description is
 * kept only on the first message of that sender (and revision of the description) the context has
 * shown, and a channel's role line only on the first message of that channel. The input is not
 * changed. Raft's `elideSeenSenders`, with the channel role line in the place of its channel card.
 * The claims stand once this returns: the CLI prints the response right away, so there is no later
 * delivery to wait for (Raft releases a claim when its output was not delivered).
 */
export function elideSeenInContext(
  messages: readonly AgentMessageRecord[],
  ledger: AgentContextLedger,
): AgentMessageRecord[] {
  return messages.map((message) => {
    let next = message;
    if (
      message.senderDescription &&
      message.senderKind !== "system" &&
      !ledger.claim(
        "sender",
        `${message.senderKind}:${message.senderHandle}`,
        message.senderDescription,
      )
    )
      next = { ...next, senderDescription: "" };
    const channel = message.target.startsWith("#") ? message.target.split(":")[0]! : undefined;
    if (
      message.channelCoordination &&
      channel &&
      !ledger.claim("channel", channel, message.channelCoordination)
    ) {
      const { channelCoordination: _shown, ...rest } = next;
      next = rest;
    }
    return next;
  });
}

/** `elideSeenInContext` for one Agent's read, or the messages as they are when the Agent's runtime
 * does not report compaction. */
export function elideForAgent(
  contexts: Pick<AgentContexts, "ledger"> | undefined,
  agentId: string,
  messages: AgentMessageRecord[],
): AgentMessageRecord[] {
  const ledger = contexts?.ledger(agentId);
  return ledger && messages.length ? elideSeenInContext(messages, ledger) : messages;
}
