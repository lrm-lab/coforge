/** How close a used share is to its limit, in the semantic colour names the UI draws it with. */
export type UsageRisk = "success" | "warning" | "error";

const WARNING_FROM_PERCENT = 70;
const ERROR_FROM_PERCENT = 90;

/**
 * The one threshold rule for every used share the product shows: a runtime usage window and an
 * Agent's context window. Under 70% is fine, 70% up to 90% is a warning, and 90% or more is an
 * error, as is a window the provider already reports at its limit.
 */
export function usageRisk(usedPercent: number, limitReached = false): UsageRisk {
  if (limitReached || usedPercent >= ERROR_FROM_PERCENT) return "error";
  if (usedPercent >= WARNING_FROM_PERCENT) return "warning";
  return "success";
}

/** The fill of a bar or dot for each risk, in the semantic solid tokens the health dot uses. */
export const USAGE_RISK_FILL_CLASS: Record<UsageRisk, string> = {
  success: "bg-success-solid",
  warning: "bg-warning-solid",
  error: "bg-error-solid",
};
