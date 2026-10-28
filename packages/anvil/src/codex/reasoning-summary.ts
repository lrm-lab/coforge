import { join } from "node:path";
import type { CodexRuntimeHost } from "./host";
import { codexHomeDirectory } from "./session-rollout";

/** Ask Codex to return a readable summary of each reasoning block. */
const SUMMARY_AUTO = "auto";

const SETTING = "model_reasoning_summary";

/**
 * The `model_reasoning_summary` this launch asks Codex for, or `undefined` to leave the choice to
 * Codex. Several models default to `none`, so their thinking arrives with no readable text; asking
 * for `auto` gives the Activity something to show.
 *
 * The user's own `config.toml` comes first: an assignment there - top level or inside a profile -
 * is left to Codex, including `none`. An absent or unreadable file asks for the summary.
 */
export async function codexReasoningSummary(
  environment: Readonly<Record<string, string>>,
  host: CodexRuntimeHost,
): Promise<string | undefined> {
  const home = codexHomeDirectory(environment, host);
  const text = home
    ? await host.readFileText(join(home, "config.toml")).catch(() => undefined)
    : undefined;
  if (text !== undefined && assignsReasoningSummary(text)) return undefined;
  return SUMMARY_AUTO;
}

/** A TOML assignment to the key, bare or table-qualified; the value is Codex's business. */
function assignsReasoningSummary(text: string): boolean {
  for (const line of text.split("\n")) {
    const statement = line.trim();
    if (!statement || statement.startsWith("#") || statement.startsWith("[")) continue;
    const separator = statement.indexOf("=");
    if (separator < 0) continue;
    const key = statement
      .slice(0, separator)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === SETTING || key.endsWith(`.${SETTING}`)) return true;
  }
  return false;
}
