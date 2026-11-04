import {
  AGENT_APP_MARKETPLACE_LIMIT_DEFAULT,
  AGENT_APP_MARKETPLACE_LIMIT_MAX,
  AGENT_APP_MARKETPLACE_QUERY_MAX,
  type AgentAppMarketplaceResponse,
} from "@lrm/coforge-sdk/agent";
import { foldUntrustedLine, frameUntrustedText } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";

/** The longest `query` the marketplace route accepts, after trimming. */
export const MARKETPLACE_QUERY_MAX_CHARS = AGENT_APP_MARKETPLACE_QUERY_MAX;
/** `--limit` bounds and default, as the route defines them. */
export const MARKETPLACE_LIMIT_MIN = 1;
export const MARKETPLACE_LIMIT_MAX = AGENT_APP_MARKETPLACE_LIMIT_MAX;
export const MARKETPLACE_LIMIT_DEFAULT = AGENT_APP_MARKETPLACE_LIMIT_DEFAULT;

export type AppMarketplaceInvocation = {
  command: "app-marketplace";
  query?: string;
  limit: number;
  json: boolean;
};

export const APP_MARKETPLACE_USAGE =
  "Usage: coforge app marketplace [<query>] [--limit <1-50>] [--json]";

/**
 * Parses `coforge app marketplace`: one optional positional query (the same text `--query` may
 * carry), a bounded limit, and `--json`. The route's own limits are enforced here first, so a bad
 * call never leaves the Computer.
 */
export function parseAppMarketplaceArgs(args: readonly string[]): AppMarketplaceInvocation {
  let query: string | undefined;
  let limit = MARKETPLACE_LIMIT_DEFAULT;
  let json = false;
  const setQuery = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > MARKETPLACE_QUERY_MAX_CHARS)
      throw new CliError({
        code: "INVALID_ARG",
        message: `The marketplace query is at most ${MARKETPLACE_QUERY_MAX_CHARS} characters.`,
        retryable: false,
      });
    query = trimmed || undefined;
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--limit") {
      const value = args[++index];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < MARKETPLACE_LIMIT_MIN ||
        parsed > MARKETPLACE_LIMIT_MAX
      )
        throw new CliError({
          code: "INVALID_ARG",
          message: `--limit takes a whole number from ${MARKETPLACE_LIMIT_MIN} to ${MARKETPLACE_LIMIT_MAX}.`,
          retryable: false,
        });
      limit = parsed;
      continue;
    }
    if (argument === "--query") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new CliError({
          code: "INVALID_ARG",
          message: `--query needs a value. ${APP_MARKETPLACE_USAGE}`,
          retryable: false,
        });
      setQuery(value);
      continue;
    }
    if (argument.startsWith("--") || query !== undefined)
      throw new CliError({
        code: "INVALID_ARG",
        message: APP_MARKETPLACE_USAGE,
        retryable: false,
      });
    setQuery(argument);
  }
  return { command: "app-marketplace", ...(query === undefined ? {} : { query }), limit, json };
}

/** Every failure the marketplace command reports, whatever its cause: one code, as #100 defines. */
export function marketplaceFailure(error: unknown): CliError {
  return new CliError({
    code: "INTEGRATION_MARKETPLACE_FAILED",
    message: `The app marketplace could not be read: ${error instanceof Error ? error.message : String(error)}`,
    retryable: false,
  });
}

function installs(count: number): string {
  return `${count} ${count === 1 ? "install" : "installs"}`;
}

/**
 * The marketplace as text. Every field the app's author supplied is untrusted: names, summaries
 * and developer names are folded to one line, and the description is framed, so an app cannot
 * forge the list around it.
 */
export function formatMarketplace(result: AgentAppMarketplaceResponse): string {
  const header = [
    `Marketplace: ${result.apps.length} ${result.apps.length === 1 ? "app" : "apps"}`,
    result.query ? ` matching ${JSON.stringify(foldUntrustedLine(result.query))}` : "",
    result.truncated ? ` (more than ${result.limit}; narrow the query to see the rest)` : "",
    ".",
  ].join("");
  if (result.apps.length === 0) return `${header}\nNo published app matches.`;
  const rows = result.apps.map((app) => {
    const marks = [
      app.installed ? "installed" : "not installed",
      installs(app.installCount),
      app.publishedAt ? `published ${app.publishedAt}` : "unpublished",
    ];
    return [
      `- ${foldUntrustedLine(app.key)} — ${foldUntrustedLine(app.name)} (${marks.join(" · ")})`,
      `  by ${foldUntrustedLine(app.developer)} · ${foldUntrustedLine(app.category)}`,
      ...(app.homepageHost ? [`  ${foldUntrustedLine(app.homepageHost)}`] : []),
      `  ${frameUntrustedText(app.description)}`,
    ].join("\n");
  });
  return [header, ...rows, "", "Install an app from the Web app's Marketplace."].join("\n");
}
