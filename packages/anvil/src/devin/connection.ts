import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { asRecord } from "#src/json-record";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { DevinRuntimeHost } from "./host";

export const DEVIN_ACP_ARGS = ["acp"] as const;
export const DEVIN_ACP_TIMEOUT_MS = 120_000;

export const DEVIN_PROFILE: AcpRuntimeProfile = {
  args: DEVIN_ACP_ARGS,
  readConfig: readConfigOptions,
  messages: {
    unsupportedProtocol: "Unsupported Devin ACP protocol version",
    closedBeforeConfig: "Devin ACP process closed before configuration",
    timedOut: "Devin ACP operation timed out",
  },
};

export type DevinConnection = AcpConnection;

export function devinConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: DevinRuntimeHost,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  return acpProcess(DEVIN_PROFILE, {
    command,
    cwd,
    environment,
    clientInfo: host.clientInfo,
    processTreeSpawner: host.processTreeSpawner,
    onUpdate: (method, params) => {
      if (method !== "session/update") return;
      const update = asUpdate(params);
      if (typeof params.sessionId === "string" && update) onUpdate(params.sessionId, update);
    },
    onPermission,
    onPromptWrite,
  });
}

export function devinBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, DEVIN_PROFILE.messages.timedOut);
}

function asUpdate(params: Readonly<Record<string, unknown>>) {
  const update = params.update;
  return typeof update === "object" && update !== null
    ? (update as Readonly<Record<string, unknown>>)
    : undefined;
}

function readConfigOptions(
  update: Readonly<Record<string, unknown>>,
): SessionConfigOption[] | undefined {
  if (update.sessionUpdate !== "config_option_update" || !Array.isArray(update.configOptions))
    return undefined;
  // One malformed entry must not throw inside the update tap and break the record stream.
  return update.configOptions.filter(
    (entry): entry is SessionConfigOption =>
      typeof asRecord(entry)?.id === "string" && typeof asRecord(entry)?.type === "string",
  );
}
