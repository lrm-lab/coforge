import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { AcpConnection, acpBounded, type AcpConnectionHost } from "#src/acp/connection";

export const COMMAND_CODE_ACP_ARGS = ["acp"] as const;
export const COMMAND_CODE_ACP_TIMEOUT_MS = 120_000;

export type CommandCodeConnection = AcpConnection;

/**
 * `--mod` is global and applies after `acp`. A catalog probe passes no mod path: the model list is
 * on session/new and does not need the instruction hook. `--safe-mode` would skip `--mod`, so a
 * real session never sets it.
 */
export function commandCodeConnection(
  command: readonly string[],
  modPath: string | undefined,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: AcpConnectionHost,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  const argv = [...command, ...COMMAND_CODE_ACP_ARGS];
  if (modPath) argv.push("--mod", modPath);
  return new AcpConnection({
    command: argv,
    cwd,
    environment,
    host,
    messages: {
      unsupportedProtocol: "Unsupported Command Code ACP protocol version",
      closedBeforeConfig: "Command Code ACP process closed before configuration",
      timedOut: "Command Code ACP operation timed out",
    },
    readConfig: readConfigOptions,
    onUpdate,
    onPermission,
    onPromptWrite,
  });
}

export function commandCodeBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, "Command Code ACP operation timed out");
}

function readConfigOptions(
  update: Readonly<Record<string, unknown>>,
): SessionConfigOption[] | undefined {
  if (update.sessionUpdate !== "config_option_update" || !Array.isArray(update.configOptions))
    return undefined;
  return update.configOptions as SessionConfigOption[];
}
