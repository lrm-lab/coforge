import { join } from "node:path";

/**
 * The account's rate-limit tier from Claude Code's own configuration (`~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the directory is moved). That file is Claude Code's
 * state, not its credential store: only the two tier fields under `oauthAccount` are read, and
 * nothing is logged or kept.
 */
export async function readClaudePlanTier(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<string | undefined> {
  const directory =
    environment.CLAUDE_CONFIG_DIR?.trim() ||
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim();
  if (!directory) return undefined;
  let config: unknown;
  try {
    config = await Bun.file(join(directory, ".claude.json")).json();
  } catch {
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const account = (config as { oauthAccount?: unknown }).oauthAccount;
  if (!account || typeof account !== "object" || Array.isArray(account)) return undefined;
  const fields = account as Record<string, unknown>;
  const tier = [fields.userRateLimitTier, fields.organizationRateLimitTier].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return tier?.trim();
}
