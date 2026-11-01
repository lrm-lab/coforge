import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { asRecord } from "#src/json-record";
import { AcpConnection, acpBounded, type AcpConnectionHost } from "#src/acp/connection";

export const DSH_ACP_ARGS = ["--profile", "acp"] as const;
export const DSH_ACP_TIMEOUT_MS = 120_000;

export type DshConnection = AcpConnection;

export function dshConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: AcpConnectionHost,
  patchPath: string,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  return new AcpConnection({
    command: [...command, ...DSH_ACP_ARGS, "--patch", patchPath],
    cwd,
    environment,
    host,
    messages: {
      unsupportedProtocol: "Unsupported DSH ACP protocol version",
      closedBeforeConfig: "DSH ACP process closed before configuration",
      timedOut: "DSH ACP operation timed out",
    },
    onUpdate: (method, params) => {
      if (method !== "session/update") return;
      const update = asRecord(params.update);
      if (typeof params.sessionId === "string" && update) onUpdate(params.sessionId, update);
    },
    onPermission,
    onPromptWrite,
  });
}

export function dshBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, "DSH ACP operation timed out");
}
