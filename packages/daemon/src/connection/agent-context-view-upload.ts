import {
  encodeAgentContextViewResult,
  type AgentContextViewResult,
} from "@lrm/coforge-sdk/internal";

export type AgentContextViewUploadMetadata = {
  postedBytes: number;
  compressedBytes: number;
  httpStatus: number;
};

export type AgentContextViewUploadError = Error &
  Partial<Pick<AgentContextViewUploadMetadata, "postedBytes" | "compressedBytes" | "httpStatus">>;

export async function postAgentContextViewResult(
  serverHttpUrl: string | undefined,
  token: string | undefined,
  result: AgentContextViewResult,
  agentApiKey?: string,
): Promise<AgentContextViewUploadMetadata> {
  if (!serverHttpUrl || !token) throw new Error("context view HTTP endpoint unavailable");
  const body = encodeAgentContextViewResult(result);
  const compressed = Bun.gzipSync(Buffer.from(body));
  let response: Response;
  try {
    response = await fetch(
      `${new URL(serverHttpUrl).origin}/internal/computer/agent-context/${result.requestId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(agentApiKey ? { "x-coforge-agent-api-key": `Bearer ${agentApiKey}` } : {}),
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-raft-client": "daemon-agent-context-view",
          "x-raft-context-uncompressed-bytes": String(body.byteLength),
        },
        body: compressed,
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    const uploadError = error instanceof Error ? error : new Error(String(error));
    Object.assign(uploadError, {
      postedBytes: body.byteLength,
      compressedBytes: compressed.byteLength,
    });
    throw uploadError as AgentContextViewUploadError;
  }
  if (!response.ok) {
    const error = Object.assign(
      new Error(`context view result upload failed: ${response.status}`),
      {
        postedBytes: body.byteLength,
        compressedBytes: compressed.byteLength,
        httpStatus: response.status,
      },
    );
    throw error as AgentContextViewUploadError;
  }
  return {
    postedBytes: body.byteLength,
    compressedBytes: compressed.byteLength,
    httpStatus: response.status,
  };
}
