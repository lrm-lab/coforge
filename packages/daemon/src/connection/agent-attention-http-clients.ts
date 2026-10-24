import type {
  AgentInboxListResponse,
  AgentMentionActionErrorCode,
  AgentMentionDeliveryErrorCode,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteResponse,
  AgentMentionPendingResponse,
  AgentThreadListResponse,
} from "@lrm/coforge-sdk/agent";
import { AgentMentionActionRequestError } from "./agent-mention-action-request-error";
import { AgentMentionDeliveryRequestError } from "./agent-mention-delivery-request-error";
import type { AgentMessageHttpClient } from "./agent-http-clients";
import { getAgentEnvelopeJson, postAgentEnvelopeJson, type HttpFetch } from "./agent-http-wire";

function mentionActionError(errorCode: string, message: string, status: number): Error {
  return new AgentMentionActionRequestError(
    errorCode as AgentMentionActionErrorCode,
    message,
    status,
  );
}

const plainError = (_errorCode: string, message: string) => new Error(message);

/** What the Agent is asked to attend to: mention actions and deliveries, followed threads, the Inbox. */
export const createAgentAttentionHttpClient = (
  httpClient: HttpFetch,
): Pick<
  AgentMessageHttpClient,
  | "requestMentionPending"
  | "requestInboxList"
  | "requestThreadList"
  | "requestMentionExecute"
  | "requestMentionDelivery"
> => ({
  requestMentionPending: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentMentionPendingResponse>(
      httpClient,
      { ...keys, what: "agent mention pending", query: { limit: request.limit?.toString() } },
      mentionActionError,
    ),
  requestInboxList: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentInboxListResponse>(
      httpClient,
      {
        ...keys,
        what: "agent inbox list",
        query: { view: request.view, before_seq: request.beforeSeq?.toString() },
      },
      plainError,
    ),
  requestThreadList: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentThreadListResponse>(
      httpClient,
      { ...keys, what: "agent thread list", query: {} },
      plainError,
    ),
  requestMentionExecute: ({ request, ...keys }) =>
    postAgentEnvelopeJson<AgentMentionExecuteResponse>(
      httpClient,
      { ...keys, what: "agent mention action", body: request },
      mentionActionError,
    ),
  requestMentionDelivery: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentMentionDeliveryResponse>(
      httpClient,
      { ...keys, what: "agent mention delivery", query: {} },
      (errorCode, message, status) =>
        new AgentMentionDeliveryRequestError(
          errorCode as AgentMentionDeliveryErrorCode,
          message,
          status,
        ),
    ),
});
