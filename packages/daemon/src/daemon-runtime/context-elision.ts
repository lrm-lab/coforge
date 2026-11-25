import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import type { AgentContexts } from "./agent-contexts";
import type {
  AgentContextLedger,
  ContextObservationEntry,
  ContextObservationKind,
} from "#src/persistence/agent-context-ledger";
import { holdClaims } from "./response-claims";

function channelOf(target: string): string | undefined {
  return target.startsWith("#") ? target.split(":")[0] : undefined;
}

export function elideSeenInContext(
  messages: readonly AgentMessageRecord[],
  ledger: AgentContextLedger,
): { messages: AgentMessageRecord[]; release: () => void } {
  const candidates: ContextObservationEntry[] = [];
  const lastTextByKey = new Map<string, string>();
  const senderSlot = new Int32Array(messages.length).fill(-2);
  const channelSlot = new Int32Array(messages.length).fill(-2);

  const enqueue = (kind: ContextObservationKind, id: string, text: string): number => {
    const key = `${kind}\0${id}`;
    if (lastTextByKey.get(key) === text) return -1;
    lastTextByKey.set(key, text);
    candidates.push([kind, id, text]);
    return candidates.length - 1;
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.senderDescription && message.senderKind !== "system") {
      senderSlot[i] = enqueue(
        "sender",
        `${message.senderKind}:${message.senderHandle}`,
        message.senderDescription,
      );
    }
    const channel = channelOf(message.target);
    if (message.channelCoordination && channel) {
      channelSlot[i] = enqueue("channel", channel, message.channelCoordination);
    }
  }

  const results =
    typeof ledger.claimBatch === "function"
      ? ledger.claimBatch(candidates)
      : candidates.map(([kind, id, text]) => ledger.claim(kind, id, text));
  const claimed: ContextObservationEntry[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (results[i]) claimed.push(candidates[i]!);
  }

  const elided = messages.map((message, i) => {
    let next = message;
    const sIdx = senderSlot[i]!;
    if (sIdx === -1 || (sIdx >= 0 && !results[sIdx])) {
      next = { ...next, senderDescription: "" };
    }
    const cIdx = channelSlot[i]!;
    if (cIdx === -1 || (cIdx >= 0 && !results[cIdx])) {
      const { channelCoordination: _shown, ...rest } = next;
      next = rest;
    }
    return next;
  });

  return {
    messages: elided,
    release: () => {
      if (typeof ledger.releaseBatch === "function") {
        ledger.releaseBatch(claimed);
        return;
      }
      claimed.forEach(([kind, id, text]) => ledger.release(kind, id, text));
    },
  };
}

/** `elideSeenInContext` for one Agent's read, or the messages as they are when the Agent's adapter
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
