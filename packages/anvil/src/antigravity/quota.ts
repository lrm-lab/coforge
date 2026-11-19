import type { AgentRuntimeEvent } from "@coforge/agent";

type FailureEvent = Extract<AgentRuntimeEvent, { type: "error" }>;
type ProviderLimit = NonNullable<FailureEvent["providerLimit"]>;

const INDIVIDUAL_QUOTA_SENTENCE =
  /Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\./u;

const STANDALONE_IN_BAND_QUOTA =
  /^\s*⚠\s*(Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.)\s*$/u;

function resetInstant(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  nowMs: number,
): string | undefined {
  const totalSeconds = Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  if (!Number.isFinite(totalSeconds)) return undefined;
  const reset = new Date(nowMs + totalSeconds * 1_000);
  return Number.isNaN(reset.getTime()) ? undefined : reset.toISOString();
}

export function parseAntigravityQuotaLimit(
  text: string,
  nowMs: number = Date.now(),
): ProviderLimit | undefined {
  const match = INDIVIDUAL_QUOTA_SENTENCE.exec(text);
  if (!match) return undefined;
  const resetsAt = resetInstant(match[1], match[2], match[3], nowMs);
  return resetsAt ? { kind: "window_limit", resetsAt } : undefined;
}

export function parseAntigravityInBandQuota(
  message: string,
  nowMs: number = Date.now(),
): FailureEvent | undefined {
  const match = STANDALONE_IN_BAND_QUOTA.exec(message);
  if (!match) return undefined;
  const resetsAt = resetInstant(match[2], match[3], match[4], nowMs);
  if (!resetsAt) return undefined;
  return {
    type: "error",
    message: match[1]!,
    providerLimit: { kind: "window_limit", resetsAt },
  };
}
