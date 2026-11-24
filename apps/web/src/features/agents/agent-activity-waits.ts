import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { ActivityEntry } from "./agent-activity";

export type ModelResponseWaitEntry = {
  startedAtMs: number;
  endedAtMs?: number;
  isHead: boolean;
};

export function computeModelResponseWaits(
  activity: readonly Pick<
    ActivityEntry,
    "launchId" | "clientSeq" | "detailKind" | "detail" | "observedAtMs"
  >[],
): Map<string, ModelResponseWaitEntry> {
  const waits = new Map<string, ModelResponseWaitEntry>();
  const nextObservedAtByLaunch = new Map<string, number>();

  for (let index = 0; index < activity.length; index += 1) {
    const entry = activity[index]!;
    const isWait =
      entry.detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED &&
      entry.detail === "Waiting for model response";
    if (isWait) {
      waits.set(`${entry.launchId}:${entry.clientSeq}:0`, {
        startedAtMs: entry.observedAtMs,
        endedAtMs: nextObservedAtByLaunch.get(entry.launchId),
        isHead: index === 0,
      });
    }
    if (
      entry.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED &&
      entry.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.TOOL_END
    ) {
      nextObservedAtByLaunch.set(entry.launchId, entry.observedAtMs);
    }
  }

  return waits;
}
