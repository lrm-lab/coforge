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

/** What an elision pass took from the ledger: handed back with `release` when the messages never
 * reached the Agent. */
type Claim = { kind: ContextObservationKind; id: string; rev: string };

export type ContextElision = {
  messages: AgentMessageRecord[];
  /** Call once the messages are really delivered (`true`) or are not (`false`: the claims go back,
   * so the next output shows what this one would have). */
  settle: (delivered: boolean) => void;
};

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
 */
export function elideSeenInContext(
  messages: readonly AgentMessageRecord[],
  ledger: AgentContextLedger,
): ContextElision {
  const claimed: Claim[] = [];
  const claim = (kind: ContextObservationKind, id: string, rev: string): boolean => {
    if (!ledger.claim(kind, id, rev)) return false;
    claimed.push({ kind, id, rev });
    return true;
  };
  const out = messages.map((message) => {
    let next = message;
    if (message.senderDescription && message.senderKind !== "system") {
      const id = `${message.senderKind}:${message.senderHandle}`;
      if (!claim("sender", id, message.senderDescription))
        next = { ...next, senderDescription: "" };
    }
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
    messages: out,
    settle: (delivered) => {
      if (delivered) return;
      for (const { kind, id, rev } of claimed) ledger.release(kind, id, rev);
    },
  };
}

/** `elideSeenInContext` for one Agent's read, or the messages as they are when the Agent's runtime
 * does not report compaction. The claims stand once the response is built: the CLI prints it right
 * away, so there is no later delivery to wait for. */
export function elideForAgent(
  contexts: Pick<AgentContexts, "ledger"> | undefined,
  agentId: string,
  messages: AgentMessageRecord[],
): AgentMessageRecord[] {
  const ledger = contexts?.ledger(agentId);
  if (!ledger || messages.length === 0) return messages;
  const elision = elideSeenInContext(messages, ledger);
  elision.settle(true);
  return elision.messages;
}
