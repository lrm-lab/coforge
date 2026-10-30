import {
  RUNTIME_PROVIDER,
  type AgentMessageRecord,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { AgentContexts } from "./agent-contexts";
import type {
  AgentContextLedger,
  ContextObservationKind,
} from "#src/persistence/agent-context-ledger";
import { holdClaims } from "./response-claims";

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
 * `release` gives the claims back when the messages never reached the Agent.
 */
export function elideSeenInContext(
  messages: readonly AgentMessageRecord[],
  ledger: AgentContextLedger,
): { messages: AgentMessageRecord[]; release: () => void } {
  const claimed: Array<[ContextObservationKind, string, string]> = [];
  const claim = (kind: ContextObservationKind, id: string, text: string) => {
    const first = ledger.claim(kind, id, text);
    if (first) claimed.push([kind, id, text]);
    return first;
  };
  const elided = messages.map((message) => {
    let next = message;
    if (
      message.senderDescription &&
      message.senderKind !== "system" &&
      !claim("sender", `${message.senderKind}:${message.senderHandle}`, message.senderDescription)
    )
      next = { ...next, senderDescription: "" };
    const channel = channelOf(message.target);
    if (
      message.channelCoordination &&
      channel &&
      !claim("channel", channel, message.channelCoordination)
    ) {
      const { channelCoordination: _shown, ...rest } = next;
      next = rest;
    }
    return next;
  });
  return {
    messages: elided,
    release: () => claimed.forEach(([kind, id, text]) => ledger.release(kind, id, text)),
  };
}

/** `elideSeenInContext` for one Agent's read, or the messages as they are when the Agent's runtime
 * does not report compaction or the operation's output does not print a sender's description and
 * a channel's role line (a search hit does not, so it must not use them up). */
export function elideForAgent(
  contexts: Pick<AgentContexts, "ledger"> | undefined,
  agentId: string,
  messages: AgentMessageRecord[],
  operation: string,
): AgentMessageRecord[] {
  if (messages.length === 0 || operation === "search") return messages;
  try {
    const ledger = contexts?.ledger(agentId);
    if (!ledger) return messages;
    const elision = elideSeenInContext(messages, ledger);
    holdClaims(elision.messages, elision.release);
    return elision.messages;
  } catch {
    // A ledger that cannot be read must never cost the Agent a message's text.
    return messages;
  }
}
