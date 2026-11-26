import type { AgentConsumptionScope } from "@lrm/coforge-sdk/agent";
import { isTaskConversationTarget, threadRootTarget } from "@lrm/coforge-sdk/internal";

export function displayConsumptionRoot(target: string): string | undefined {
  return isTaskConversationTarget(target) ? undefined : threadRootTarget(target)?.toLowerCase();
}

export function matchesConsumptionScope(target: string, scope: AgentConsumptionScope): boolean {
  const displayed = displayConsumptionRoot(target);
  const authority = scope.threadRootId?.toLowerCase();
  return (
    displayed === authority ||
    Boolean(
      displayed &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4})?$/.test(displayed) &&
      authority?.startsWith(displayed),
    )
  );
}

export function messageConsumptionKey(
  conversationId: string,
  target: string,
  threadRootId = displayConsumptionRoot(target),
): string {
  return JSON.stringify([conversationId, threadRootId?.toLowerCase() ?? ""]);
}

export function lookupConsumptionKey(
  spellings: ReadonlyMap<string, string | null>,
  conversationId: string,
  target: string,
): string {
  const displayed = messageConsumptionKey(conversationId, target);
  return spellings.get(displayed) ?? displayed;
}

export function rememberConsumptionSpelling(
  spellings: Map<string, string | null>,
  conversationId: string,
  target: string,
  threadRootId: string | undefined,
): string {
  const displayed = messageConsumptionKey(conversationId, target);
  if (threadRootId === undefined) return displayed;
  const canonical = messageConsumptionKey(conversationId, target, threadRootId);
  if (canonical === displayed || !matchesConsumptionScope(target, { conversationId, threadRootId }))
    return canonical;
  const prior = spellings.get(displayed);
  spellings.set(displayed, prior === undefined || prior === canonical ? canonical : null);
  return canonical;
}
