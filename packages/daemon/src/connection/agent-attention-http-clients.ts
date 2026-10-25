import type {
  AgentAttachmentCommentsErrorCode,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentMentionDeliveryRequest,
  AgentMentionExecuteRequest,
  AgentMentionPendingRequest,
  AgentMentionActionErrorCode,
  AgentMentionDeliveryErrorCode,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteResponse,
  AgentMentionPendingResponse,
  AgentThreadListResponse,
} from "@lrm/coforge-sdk/agent";
import { AgentAttachmentCommentsRequestError } from "./agent-attachment-comments-request-error";
import { AgentMentionActionRequestError } from "./agent-mention-action-request-error";
import { AgentMentionDeliveryRequestError } from "./agent-mention-delivery-request-error";
import {
  getAgentEnvelopeJson,
  postAgentEnvelopeJson,
  type AgentHttpInput,
  type HttpFetch,
} from "./agent-http-wire";

/** The routes that tell an Agent what to attend to; `AgentMessageHttpClient` extends it. */
export interface AgentAttentionHttpClient {
  requestMentionPending?(
    input: AgentHttpInput<AgentMentionPendingRequest>,
  ): Promise<AgentMentionPendingResponse>;
  requestInboxList?(input: AgentHttpInput<AgentInboxRequest>): Promise<AgentInboxListResponse>;
  requestThreadList?(
    input: AgentHttpInput<Record<string, never>>,
  ): Promise<AgentThreadListResponse>;
  requestMentionExecute?(
    input: AgentHttpInput<AgentMentionExecuteRequest>,
  ): Promise<AgentMentionExecuteResponse>;
  requestMentionDelivery?(
    input: AgentHttpInput<AgentMentionDeliveryRequest>,
  ): Promise<AgentMentionDeliveryResponse>;
  requestAttachmentComments?(
    input: AgentHttpInput<AgentAttachmentCommentsRequest>,
  ): Promise<AgentAttachmentCommentsResponse>;
}

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
): AgentAttentionHttpClient => ({
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
        query: { view: request.view, before: request.before?.toString() },
      },
      plainError,
    ),
  requestThreadList: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentThreadListResponse>(
      httpClient,
      { ...keys, what: "agent thread list", query: {} },
      plainError,
    ),
  requestAttachmentComments: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentAttachmentCommentsResponse>(
      httpClient,
      {
        ...keys,
        what: "agent attachment comments",
        query: { limit: request.limit?.toString(), before: request.before?.toString() },
      },
      (errorCode, message, status) =>
        new AgentAttachmentCommentsRequestError(
          errorCode as AgentAttachmentCommentsErrorCode,
          message,
          status,
        ),
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
