import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";

export const RESET_CREDIT_HIGH_USAGE_PERCENT = 80;

export type ResetCreditPrompt = {
  available: number;
  variant: "primary" | "secondary";
};

type WindowSample = {
  status?: "ok" | "limit_reached" | "parse_unavailable";
  usedPercent?: number;
};

function bucketUsedPercent(bucket: {
  usedPercent?: number;
  remainingFraction?: number;
}): number | undefined {
  if (bucket.usedPercent !== undefined) return bucket.usedPercent;
  if (bucket.remainingFraction !== undefined) {
    return Math.round((1 - bucket.remainingFraction) * 10_000) / 100;
  }
  return undefined;
}

function collectWindows(snapshot: UsageSnapshot): WindowSample[] {
  const samples: WindowSample[] = [];
  if (snapshot.primary) {
    samples.push({ status: snapshot.primary.status, usedPercent: snapshot.primary.usedPercent });
  }
  if (snapshot.secondary) {
    samples.push({
      status: snapshot.secondary.status,
      usedPercent: snapshot.secondary.usedPercent,
    });
  }
  if (snapshot.officialGroups) {
    for (const group of snapshot.officialGroups) {
      for (const bucket of group.buckets) {
        samples.push({ status: bucket.status, usedPercent: bucketUsedPercent(bucket) });
      }
    }
  }
  return samples;
}

export function resetCreditPrompt(
  snapshot: UsageSnapshot | undefined,
): ResetCreditPrompt | undefined {
  if (!snapshot || snapshot.provider !== RUNTIME_PROVIDER.CODEX) return undefined;
  const available = snapshot.resetCreditsAvailable;
  if (available === undefined || available <= 0) return undefined;
  const windows = collectWindows(snapshot);
  const hasWindowAtLimit = windows.some((window) => window.status === "limit_reached");
  if (snapshot.health === "rate_limited" || hasWindowAtLimit) {
    return { available, variant: "primary" };
  }
  const hasHighUsage = windows.some(
    (window) =>
      window.usedPercent !== undefined && window.usedPercent >= RESET_CREDIT_HIGH_USAGE_PERCENT,
  );
  if (hasHighUsage) {
    return { available, variant: "secondary" };
  }
  return undefined;
}

export function canOfferAgentResetCredit(profile: {
  runtimeUsageVisible: boolean;
  runtimeCredential: unknown;
}): boolean {
  return profile.runtimeUsageVisible && profile.runtimeCredential == null;
}
