import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";

type UsageWindowShape = { id?: string; windowDurationMinutes: number };

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/**
 * What each runtime's usage windows are called in the usage popover. The snapshot is shared, but
 * the runtimes fill its two slots differently (task #109), so the label comes from the runtime:
 *
 * - Claude Code: "Current session" and "Current week", as `/usage` prints them. Its window length
 *   is the time left until the reset, not the window's length, so it cannot be read by duration.
 * - Antigravity: its 5-hour and weekly quota buckets.
 * - Kiro: one monthly credit allowance.
 * - Grok: the billing period (weekly or monthly) and, when the account has an on-demand cap, its
 *   pay-as-you-go spend in the second slot.
 * - Codex and anything newer: the window's own length, which they report truthfully.
 */
export function usageWindowLabel(
  provider: RuntimeProvider,
  key: "primary" | "secondary",
  window: UsageWindowShape,
): string {
  switch (provider) {
    case RUNTIME_PROVIDER.CLAUDE_CODE:
    case RUNTIME_PROVIDER.ANTIGRAVITY:
      return key === "primary" ? m.computer_usage_session() : m.computer_usage_weekly();
    case RUNTIME_PROVIDER.KIRO:
      return key === "primary" ? m.computer_usage_monthly_credits() : byDuration(window);
    case RUNTIME_PROVIDER.GROK:
      return window.id === "grok-pay-as-you-go"
        ? m.computer_usage_pay_as_you_go()
        : byDuration(window);
    default:
      return byDuration(window);
  }
}

export function byDuration({ windowDurationMinutes }: UsageWindowShape): string {
  if (windowDurationMinutes <= DAY_MINUTES) return m.computer_usage_session();
  if (windowDurationMinutes <= WEEK_MINUTES) return m.computer_usage_weekly();
  return m.computer_usage_monthly();
}

/** Window keys we store when the provider has no display name. They are not official copy. */
const RAW_WINDOW_LABELS: Record<string, () => string> = {
  onDemand: () => m.computer_usage_pay_as_you_go(),
  prepaidBalance: () => m.computer_usage_prepaid_balance(),
  individualLimit: () => m.computer_usage_spend_limit(),
  bonus: () => m.computer_usage_bonus(),
  freeTrial: () => m.computer_usage_free_trial(),
  currentPeriod: () => m.computer_usage_current_period(),
};

/** The row label for one official bucket. A provider name wins, except on a bucket the provider
 * counts as a share left (`remainingFraction`): its name says so ("Weekly Limit Remaining") while
 * the row shows the share used. A stored window key is localized, then a real window length, then
 * a week or month named by the official type. */
export function officialBucketLabel(bucket: {
  name?: string;
  window?: string;
  remainingFraction?: number;
  windowDurationMinutes?: number;
}): string {
  const remainingType = bucket.remainingFraction !== undefined;
  if (bucket.name && !remainingType && !RAW_WINDOW_LABELS[bucket.name]) return bucket.name;
  const key = remainingType ? bucket.window : (bucket.window ?? bucket.name);
  const known = key ? RAW_WINDOW_LABELS[key] : undefined;
  if (known) return known();
  if (bucket.windowDurationMinutes)
    return byDuration({ windowDurationMinutes: bucket.windowDurationMinutes });
  if (key && /week/iu.test(key)) return m.computer_usage_weekly();
  if (key && /month/iu.test(key)) return m.computer_usage_monthly();
  return key ?? m.computer_usage_available();
}

/** A figure that is not a percent, such as a wrapped balance. Omitted when the row already
 * has a meter, so a bucket note does not replace the official percent. */
export function officialBucketDetail(bucket: {
  description?: string;
  remainingFraction?: number;
  usedPercent?: number;
}): string | undefined {
  if (bucket.remainingFraction !== undefined || bucket.usedPercent !== undefined) return undefined;
  return bucket.description;
}
