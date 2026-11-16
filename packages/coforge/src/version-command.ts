export type VersionInvocation = { command: "version"; json?: boolean };

export type VersionInfo = { cli: string; daemon?: string; computer?: string };

const VERSION_USAGE = "Usage: coforge version [--json]";

export function parseVersionArgs(args: readonly string[]): VersionInvocation {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new Error(VERSION_USAGE);
  }
  return { command: "version", ...(json ? { json: true } : {}) };
}

/** `coforge version`'s text output: `CLI:`/`Daemon:`/`Computer:` lines, in that order, each
 * omitted only when unknown. `CLI` is always known; `Daemon`/`Computer` come from the live query. */
export function formatVersionInfo(info: VersionInfo): string {
  const lines = [`CLI: ${info.cli}`];
  if (info.daemon) lines.push(`Daemon: ${info.daemon}`);
  if (info.computer) lines.push(`Computer: ${info.computer}`);
  return lines.join("\n");
}
