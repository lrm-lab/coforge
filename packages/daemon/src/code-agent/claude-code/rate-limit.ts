import type { UsageSnapshot } from "#src/code-agent/contract";

export function claudeRateLimitWindow(info: Record<string, unknown> | undefined):
  | {
      key: "primary" | "secondary";
      window: NonNullable<UsageSnapshot["primary"]>;
    }
  | undefined {
  if (info?.status !== "allowed" && info?.status !== "rejected") return undefined;
  const key =
    info.rateLimitType === "five_hour"
      ? "primary"
      : info.rateLimitType === "seven_day"
        ? "secondary"
        : undefined;
  if (!key || typeof info.resetsAt !== "number" || !Number.isFinite(info.resetsAt))
    return undefined;
  const reset = new Date(info.resetsAt >= 1e12 ? info.resetsAt : info.resetsAt * 1_000);
  if (Number.isNaN(reset.getTime())) return undefined;
  return {
    key,
    window: {
      status: info.status === "rejected" ? "limit_reached" : "ok",
      windowDurationMinutes: key === "primary" ? 300 : 10_080,
      resetsAt: reset.toISOString(),
    },
  };
}
