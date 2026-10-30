import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";

/**
 * Keeps the newest passively observed usage per provider: a partial reading (a scan that reported
 * only one window) completes the last one rather than replacing it.
 */
export function rememberUsage(
  observed: Map<RuntimeProvider, UsageSnapshot>,
  snapshot: UsageSnapshot,
): void {
  const current = observed.get(snapshot.provider);
  observed.set(snapshot.provider, {
    ...current,
    ...snapshot,
    primary: snapshot.primary ?? current?.primary,
    secondary: snapshot.secondary ?? current?.secondary,
    // Stamped at observation time, not when `scanUsage` later reuses this snapshot as its
    // fallback — a passively observed reading is never as fresh as "now".
    collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
  });
}
