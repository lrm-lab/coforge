/**
 * The plan name a usage page shows. `subscription_type` alone cannot tell the two paid Max
 * tiers apart: Anthropic returns `"max"` for both, and only the rate-limit tier separates the
 * $200 plan (now called Ultra) from the $100 one (Max).
 */
export function canonicalClaudePlan(
  rateLimitTier: string | undefined,
  subscriptionType: string | undefined,
): string | undefined {
  const tier = rateLimitTier?.trim().toLowerCase();
  if (tier) {
    if (tier.includes("max_20x")) return "Ultra";
    if (tier.includes("max_5x")) return "Max";
    if (tier.includes("enterprise")) return "Enterprise";
    if (tier.includes("team")) return "Team";
    if (tier.includes("pro")) return "Pro";
  }
  const plan = subscriptionType?.trim();
  if (!plan) return undefined;
  // "max" / "claude max" / "pro" read back capitalised, as Anthropic names them.
  return plan.replace(
    /(^|\s)(\p{L})/gu,
    (_, space: string, letter: string) => space + letter.toUpperCase(),
  );
}
