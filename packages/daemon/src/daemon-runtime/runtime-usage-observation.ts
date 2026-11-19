import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import { validUsageWindow } from "./runtime-activity-text";

export function currentObservedUsage(
  observed: Map<RuntimeProvider, UsageSnapshot>,
  provider: RuntimeProvider,
  now = Date.now(),
): UsageSnapshot | undefined {
  const snapshot = observed.get(provider);
  if (!snapshot) return undefined;
  const primary = validUsageWindow(snapshot.primary, now);
  const secondary = validUsageWindow(snapshot.secondary, now);
  if (!primary && !secondary) {
    observed.delete(provider);
    return undefined;
  }
  const current = { ...snapshot, primary, secondary };
  observed.set(provider, current);
  return current;
}
