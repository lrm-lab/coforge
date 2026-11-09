import {
  encodeAgentContextViewResult,
  type AgentContextViewResult,
} from "@lrm/coforge-sdk/internal";

export async function postAgentContextViewResult(
  serverHttpUrl: string | undefined,
  token: string | undefined,
  result: AgentContextViewResult,
  agentApiKey?: string,
): Promise<void> {
  if (!serverHttpUrl || !token) throw new Error("context view HTTP endpoint unavailable");
  const body = encodeAgentContextViewResult(result);
  const compressed = Bun.gzipSync(Buffer.from(body));
  const response = await fetch(
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
  if (!response.ok) throw new Error(`context view result upload failed: ${response.status}`);
}
