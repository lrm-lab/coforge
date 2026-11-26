import { COFORGE_CLI_VERSION } from "./version";
import type { MessageTransport } from "./message-transport";
import type { VersionInvocation } from "../index";
import { parseCliFlags } from "./cli-flags";

const VERSION_USAGE = "Usage: coforge version [--json]";

export function parseVersionArgs(args: readonly string[]): VersionInvocation {
  const { values } = parseCliFlags({
    args,
    options: { json: { type: "boolean" } },
    onError() {
      throw new Error(VERSION_USAGE);
    },
  });
  return { command: "version", ...(values.json ? { json: true } : {}) };
}

type VersionInfo = { cli: string; daemon?: string; computer?: string };

/** `coforge version`'s text output: `CLI:`/`Daemon:`/`Computer:` lines, in that order, each
 * omitted only when unknown. `CLI` is always known; `Daemon`/`Computer` come from the live query. */
export function formatVersionInfo(info: VersionInfo): string {
  const lines = [`CLI: ${info.cli}`];
  if (info.daemon) lines.push(`Daemon: ${info.daemon}`);
  if (info.computer) lines.push(`Computer: ${info.computer}`);
  return lines.join("\n");
}

export async function runVersion(
  invocation: VersionInvocation,
  transport: Pick<MessageTransport, "version" | "external">,
): Promise<string> {
  if (!transport.external && !transport.version)
    throw new Error("Version transport is unavailable");
  const response = transport.external ? undefined : await transport.version!();
  const info = {
    cli: COFORGE_CLI_VERSION,
    daemon: response?.daemonVersion,
    ...(response?.computerVersion ? { computer: response.computerVersion } : {}),
  };
  if (invocation.json) return JSON.stringify({ ok: true, data: info });
  return formatVersionInfo(info);
}
