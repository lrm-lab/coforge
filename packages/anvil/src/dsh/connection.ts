import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import type { DshRuntimeHost } from "./host";

export const DSH_ACP_ARGS = ["--profile", "acp"] as const;
export const DSH_ACP_TIMEOUT_MS = 120_000;

export const DSH_PROFILE: AcpRuntimeProfile = {
  args: DSH_ACP_ARGS,
  messages: {
    unsupportedProtocol: "Unsupported DSH ACP protocol version",
    closedBeforeConfig: "DSH ACP process closed before configuration",
    timedOut: "DSH ACP operation timed out",
  },
};

export type DshConnection = AcpConnection;

export function dshConnection(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  host: DshRuntimeHost,
  patchPath: string,
  onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "cancelled" },
  }),
  onPromptWrite: () => void = () => {},
): AcpConnection {
  return acpProcess(DSH_PROFILE, {
    command,
    extraArgs: ["--patch", patchPath],
    cwd,
    environment,
    clientInfo: host.clientInfo,
    processTreeSpawner: host.processTreeSpawner,
    onUpdate: (method, params) => {
      if (method !== "session/update") return;
      const update = params.update;
      if (typeof params.sessionId === "string" && typeof update === "object" && update !== null)
        onUpdate(params.sessionId, update as Readonly<Record<string, unknown>>);
    },
    onPermission,
    onPromptWrite,
  });
}

export function dshBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return acpBounded(work, timeoutMs, DSH_PROFILE.messages.timedOut);
}
