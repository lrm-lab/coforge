import type {
  DiagnosisResult,
  DiagnosisScope,
} from "#src/server/workspace-memory/explicit-diagnosis";
import type { ServerOpenVikingIdentity } from "./route-policy";
import type { OpenVikingRuntimeClient } from "./runtime-client.server";

/** Private typed control plane. Never expose session writes on the generic Memory gateway. */
export function createOpenVikingExplicitDiagnosis(deps: {
  runtime: OpenVikingRuntimeClient;
  identity(workspaceId: string, targetAgentId: string): Promise<ServerOpenVikingIdentity>;
}) {
  return async (workspaceId: string, scope: DiagnosisScope): Promise<DiagnosisResult> => {
    const identity = await deps.identity(workspaceId, scope.targetAgentId);
    const sessionId = `coforge-diagnosis-${scope.requestId}`;
    const request = async (path: string, body?: unknown) => {
      const result = await deps.runtime.request({
        method: body === undefined ? "GET" : "POST",
        path,
        identity,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!result.ok) throw new Error("diagnosis_runtime_unavailable");
      if (body === undefined && result.response.status === 404) {
        await result.response.body.cancel();
        return null;
      }
      if (result.response.status < 200 || result.response.status >= 300) {
        await result.response.body.cancel();
        throw new Error("diagnosis_runtime_refused");
      }
      const json = (await new Response(result.response.body).json()) as {
        status?: string;
        result?: unknown;
      };
      if (json.status !== "ok") throw new Error("diagnosis_runtime_invalid");
      return json.result;
    };
    const existing = await request(`/api/v1/sessions/${sessionId}/diagnosis/${scope.requestId}`);
    if (existing) return decodeResult(existing);
    await request("/api/v1/sessions", {
      session_id: sessionId,
      skill_trajectory_mode: "causal",
      auto_commit_policy: null,
    });
    await request(`/api/v1/sessions/${sessionId}/messages/batch`, {
      messages: scope.messages.map((message) => ({
        role: message.role,
        content: message.content,
        source_message_ids: message.sourceMessageIds,
        ...(message.peerId ? { peer_id: message.peerId } : {}),
      })),
    });
    const value = await request(`/api/v1/sessions/${sessionId}/diagnosis`, {
      request_id: scope.requestId,
      question: scope.question,
    });
    return decodeResult(value);
  };
}

function decodeResult(value: unknown): DiagnosisResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !["running", "completed", "failed"].includes(String(value.status))
  )
    throw new Error("diagnosis_runtime_invalid");
  return value as DiagnosisResult;
}
