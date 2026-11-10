import {
  decodeDaemonCommandResponse,
  encodeDaemonCommandRequest,
  LOCAL_RPC_METHODS,
  type ManagedRunnerIdentity,
} from "@lrm/coforge-sdk/internal";

export async function runRunnerCommand(input: {
  operation: "list" | "stop";
  workspaceId?: string;
  agentId?: string;
  ensureRunning(): Promise<void>;
  request(method: string, payload: Uint8Array): Promise<{ method: string; payload: Uint8Array }>;
  serverUrl: string;
}): Promise<ManagedRunnerIdentity[]> {
  if (input.operation === "stop" && (!input.workspaceId || !input.agentId))
    throw new Error("runner stop requires a Workspace and Agent id");
  await input.ensureRunning();
  const method =
    input.operation === "list" ? LOCAL_RPC_METHODS.RUNNERS_LIST : LOCAL_RPC_METHODS.RUNNERS_STOP;
  const requestId = crypto.randomUUID();
  const response = await input.request(
    method,
    encodeDaemonCommandRequest({
      protocolMajor: 1,
      requestId,
      expectedServerUrl: input.serverUrl,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    }),
  );
  const commandResponse = decodeDaemonCommandResponse(response.payload);
  if (
    response.method !== method ||
    commandResponse.protocolMajor !== 1 ||
    commandResponse.requestId !== requestId
  )
    throw new Error(`coforge-daemon returned an invalid runners ${input.operation} response`);
  if (!commandResponse.accepted)
    throw new Error(
      commandResponse.error || `coforge-daemon did not accept runners ${input.operation}`,
    );
  return commandResponse.runners ?? [];
}
