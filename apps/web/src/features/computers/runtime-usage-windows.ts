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

function byDuration({ windowDurationMinutes }: UsageWindowShape): string {
  if (windowDurationMinutes <= DAY_MINUTES) return m.computer_usage_session();
  if (windowDurationMinutes <= WEEK_MINUTES) return m.computer_usage_weekly();
  return m.computer_usage_monthly();
}
