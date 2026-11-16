import { withDeadline } from "@lrm/coforge-anvil";
import type { PlatformMemoryCommand, PlatformMemoryResult } from "@lrm/coforge-sdk/agent";
import type { AgentInputQueue } from "#src/daemon-runtime/runtime-launch-intent";
import { platformMemoryBriefingText } from "./platform-memory-briefing-text";

function recallQuery(queue: AgentInputQueue): string | undefined {
  for (const item of queue.items) {
    const candidates =
      item.kind === "prompt"
        ? [item.text]
        : item.kind === "delivery"
          ? [item.message.body]
          : item.kind === "recovery"
            ? [
                item.context.wakeMessage?.body,
                ...(item.context.resumeMessages ?? []).map((message) => message.body),
              ]
            : [];
    const query = candidates.find((text) => text?.trim());
    if (query) return query;
  }
  return undefined;
}

export async function attachPlatformMemoryBriefing(
  queue: AgentInputQueue | undefined,
  call: (command: PlatformMemoryCommand) => Promise<unknown>,
): Promise<void> {
  if (!queue || queue.closed) return;
  const query = recallQuery(queue);
  if (!query) return;
  try {
    const response = (await withDeadline(
      call({ operation: "search", query: query.slice(0, 1200) }),
      3000,
      () => new Error("Memory recall timed out"),
    )) as PlatformMemoryResult;
    if (
      queue.closed ||
      response?.enabled !== true ||
      !Array.isArray(response.entries) ||
      !response.entries.length
    )
      return;
    const text = platformMemoryBriefingText(response.entries);
    if (!text) return;
    const completion = Promise.withResolvers<void>();
    completion.promise.catch(() => {});
    queue.items.unshift({
      kind: "memory",
      text,
      completion: { resolve: completion.resolve, reject: completion.reject },
    });
  } catch {}
}
