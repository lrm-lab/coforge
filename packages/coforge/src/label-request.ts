import {
  agentApiRoutes,
  decodeAgentLabelListResponse,
  decodeAgentLabelWriteResponse,
  type AgentLabelListResponse,
  type AgentLabelWriteRequest,
  type AgentLabelWriteResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** The proxy's refusal body as `envelopeRequest` relays it: the Agent API's code and reason. */
function labelRefusal(value: unknown): { errorCode: string; error: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { code, error } = value as { code?: unknown; error?: unknown };
  return typeof code === "string" && typeof error === "string"
    ? { errorCode: code, error }
    : undefined;
}

const nextAction = (code: string | undefined) =>
  code === "ACCESS_DENIED"
    ? "Renaming, recoloring, deleting and restoring a label is for a Workspace owner or admin; ask one."
    : code === "NOT_FOUND"
      ? "Check the name with `coforge label list`."
      : undefined;

/** `coforge label list` and the label writes through the daemon's proxy. */
export function labelRequests(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  return {
    labelList: (): Promise<AgentLabelListResponse> =>
      envelopeRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        agentApiRoutes.local.labels,
        decodeAgentLabelListResponse,
        () => undefined,
        "label-list",
      ),
    labelWrite: (request: AgentLabelWriteRequest): Promise<AgentLabelWriteResponse> =>
      envelopeRequest(
        proxyEndpoint,
        context,
        proxyUrl,
        { ...agentApiRoutes.local.labelWrite, body: request },
        decodeAgentLabelWriteResponse,
        labelRefusal,
        "label-write",
        nextAction,
      ),
  };
}
