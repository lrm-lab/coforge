import {
  decodeDaemonCommandResponse,
  encodeDaemonCommandRequest,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";
import { DaemonCommandRejectedError } from "./daemon-command-rejected-error";

export async function runControlCommand(input: {
  operation:
    | "start"
    | "stop"
    | "restart"
    | "snapshot"
    | "upgrade"
    | "computer_upgrade"
    | "upgrade_ack"
    | "detach";
  workspaceId?: string;
  requestId: string;
  expectedVersion?: string;
  releaseChannel?: string;
  detachTarget?: { computerId: string; serverHttpUrl: string };
  serverUrl: string;
  request(method: string, payload: Uint8Array): Promise<{ method: string; payload: Uint8Array }>;
}): Promise<ManagedRuntimeIdentity[]> {
  const method = `daemon:${input.operation}`;
  const response = await input.request(
    method,
    encodeDaemonCommandRequest({
      protocolMajor: 1,
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      expectedServerUrl: input.serverUrl,
      expectedVersion: input.expectedVersion,
      releaseChannel: input.releaseChannel,
      computerId: input.detachTarget?.computerId,
      serverHttpUrl: input.detachTarget?.serverHttpUrl,
    }),
  );
  const commandResponse = decodeDaemonCommandResponse(response.payload);
  if (response.method !== method || commandResponse.protocolMajor !== 1)
    throw new Error(`coforge-daemon did not accept ${input.operation}`);
  if (commandResponse.requestId !== input.requestId || !commandResponse.accepted)
    throw new DaemonCommandRejectedError(
      input.operation,
      commandResponse.error || `coforge-daemon did not accept ${input.operation}`,
      commandResponse.errorCode,
      commandResponse.workspaceId,
    );
  const runtimes = commandResponse.runtimes ?? [];
  if (input.operation === "detach")
    (runtimes as ManagedRuntimeIdentity[] & { detachKeyRevoked?: boolean }).detachKeyRevoked =
      commandResponse.detachKeyRevoked;
  return runtimes;
}
