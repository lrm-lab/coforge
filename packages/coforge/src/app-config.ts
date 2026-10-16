import type { AgentAppConfigView } from "@lrm/coforge-sdk/agent";
import type { AppConfigValues } from "@lrm/coforge-sdk/internal";

/** `coforge app config`: read one of the Agent's own Apps' config, or change it when any `--set`
 * or `--unset` is given. */
export type AppConfigInvocation = {
  command: "app-config";
  appId: string;
  set: AppConfigValues;
  unset: string[];
  json?: boolean;
};

const APP_CONFIG_USAGE =
  "Usage: coforge app config --app <app-id> [--set <key>=<value>]... [--unset <key>]... [--json]";

const KEY = /^[a-z][a-z0-9_]*$/;
const INTEGER = /^-?(0|[1-9]\d*)$/;

function invalid(message: string): never {
  throw new Error(`${message}\n${APP_CONFIG_USAGE}`);
}

/** `true`, `false`, or a safe integer: an optional `-`, then digits with no leading zero, `+` or
 * fraction. */
function parseValue(key: string, raw: string): boolean | number {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (!INTEGER.test(raw)) invalid(`--set ${key} takes true, false or a whole number, not "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) invalid(`--set ${key}=${raw} is too large a number`);
  return value;
}

/** Every `--unset` is checked before any `--set`, so a key named by both is caught at the
 * `--set`, whichever came first on the command line. */
export function parseAppConfigArgs(args: readonly string[]): AppConfigInvocation {
  let appId: string | undefined;
  let json = false;
  const sets: string[] = [];
  const unset: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || !["--app", "--set", "--unset"].includes(arg ?? ""))
      invalid(`Unexpected argument ${arg}`);
    if (arg === "--app") appId = value;
    else (arg === "--set" ? sets : unset).push(value);
    index += 1;
  }
  appId = appId?.trim();
  if (!appId) invalid("--app is required");
  const changed = new Set<string>();
  for (const key of unset) {
    if (!KEY.test(key)) invalid(`--unset ${key} is not a config key (lowercase snake_case)`);
    if (changed.has(key)) invalid(`${key} is changed more than once`);
    changed.add(key);
  }
  const set: AppConfigValues = {};
  for (const entry of sets) {
    const equals = entry.indexOf("=");
    if (equals <= 0 || equals === entry.length - 1)
      invalid(`--set takes key=value, not "${entry}"`);
    const key = entry.slice(0, equals);
    if (!KEY.test(key)) invalid(`--set ${key} is not a config key (lowercase snake_case)`);
    if (changed.has(key)) invalid(`${key} is changed more than once`);
    changed.add(key);
    set[key] = parseValue(key, entry.slice(equals + 1));
  }
  return { command: "app-config", appId, set, unset, ...(json ? { json: true } : {}) };
}

/** One line per key, sorted, saying whether the Agent set it and what it may be. */
export function formatAppConfig(config: AgentAppConfigView): string {
  const keys = Object.keys(config.schema).sort();
  const lines = [`App ${config.appId}, config revision ${config.revision}`];
  for (const key of keys) {
    const field = config.schema[key]!;
    const kind =
      field.type === "boolean" ? "boolean" : `integer ${field.minimum}..${field.maximum}`;
    const source = Object.hasOwn(config.overrides, key)
      ? `set; default ${String(config.defaults[key])}`
      : "default";
    lines.push(`  ${key} = ${String(config.effective[key])} (${source}; ${kind})`);
  }
  if (keys.length === 0) lines.push("  (nothing to configure)");
  else
    lines.push(
      `Change it with: coforge app config --app ${config.appId} --set <key>=<value> --unset <key>`,
    );
  return lines.join("\n");
}
