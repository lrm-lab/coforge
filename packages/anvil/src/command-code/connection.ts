import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { asRecord } from "#src/json-record";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { CommandCodeRuntimeHost } from "./host";

export const COMMAND_CODE_ACP_ARGS = ["acp"] as const;
export const COMMAND_CODE_ACP_TIMEOUT_MS = 120_000;

export const COMMAND_CODE_PROFILE: AcpRuntimeProfile = {
  args: COMMAND_CODE_ACP_ARGS,
  readConfig: readConfigOptions,
  messages: {
    unsupportedProtocol: "Unsupported Command Code ACP protocol version",
    closedBeforeConfig: "Command Code ACP process closed before configuration",
    timedOut: "Command Code ACP operation timed out",
  },
};

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
  host: CommandCodeRuntimeHost,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  return acpProcess(COMMAND_CODE_PROFILE, {
    command,
    extraArgs: modPath ? ["--mod", modPath] : [],
    cwd,
    environment,
    clientInfo: host.clientInfo,
    processTreeSpawner: host.processTreeSpawner,
    onUpdate: (method, params) => {
      if (method !== "session/update") return;
      const parsed = asRecord(params);
      const update = asUpdate(params);
      if (typeof parsed?.sessionId === "string" && update) onUpdate(parsed.sessionId, update);
    },
    onPermission,
    onPromptWrite,
  });
}

export function commandCodeBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, COMMAND_CODE_PROFILE.messages.timedOut);
}

function asUpdate(params: unknown) {
  const update = asRecord(params)?.update;
  return typeof update === "object" && update !== null
    ? (update as Readonly<Record<string, unknown>>)
    : undefined;
}

function readConfigOptions(
  update: Readonly<Record<string, unknown>>,
): SessionConfigOption[] | undefined {
  if (update.sessionUpdate !== "config_option_update" || !Array.isArray(update.configOptions))
    return undefined;
  return update.configOptions as SessionConfigOption[];
}
