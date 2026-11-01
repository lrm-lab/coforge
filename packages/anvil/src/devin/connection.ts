import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { asRecord } from "#src/json-record";
import { AcpConnection, acpBounded, type AcpConnectionHost } from "#src/acp/connection";

export const DEVIN_ACP_ARGS = ["acp"] as const;
export const DEVIN_ACP_TIMEOUT_MS = 120_000;

export type DevinConnection = AcpConnection;

export function devinConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: AcpConnectionHost,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  return new AcpConnection({
    command: [...command, ...DEVIN_ACP_ARGS],
    cwd,
    environment,
    host,
    messages: {
      unsupportedProtocol: "Unsupported Devin ACP protocol version",
      closedBeforeConfig: "Devin ACP process closed before configuration",
      timedOut: "Devin ACP operation timed out",
    },
    readConfig: readConfigOptions,
    onUpdate: (method, params) => {
      if (method !== "session/update") return;
      const update = asRecord(params.update);
      if (typeof params.sessionId === "string" && update) onUpdate(params.sessionId, update);
    },
    onPermission,
    onPromptWrite,
  });
}

export function devinBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, "Devin ACP operation timed out");
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
