import type {
  AgentAppConfigErrorCode,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
  AgentLabelListResponse,
  AgentManualErrorCode,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentProfileErrorCode,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentUserInfoErrorCode,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
} from "@lrm/coforge-sdk/agent";
import type { WorkspaceInfoRequest, WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";
import { AgentManualRequestError } from "./agent-manual-request-error";
import { AgentProfileRequestError } from "./agent-profile-request-error";
import { AgentAppConfigRequestError } from "./agent-app-config-request-error";
import { AgentUserInfoRequestError } from "./agent-user-info-request-error";
import {
  getAgentEnvelopeJson,
  getAgentJson,
  postAgentEnvelopeJson,
  type AgentHttpInput,
  type HttpFetch,
} from "./agent-http-wire";

/** The workspace-scoped reads an Agent forwards: its Workspace's info, the Manual, users,
 * profiles, its Apps' config, and its labels. `AgentMessageHttpClient` extends it. */
export interface AgentWorkspaceHttpClient {
  requestWorkspaceInfo?(
    input: AgentHttpInput<WorkspaceInfoRequest>,
  ): Promise<WorkspaceInfoResponse>;
  requestManualGet?(input: AgentHttpInput<AgentManualGetRequest>): Promise<AgentManualGetResponse>;
  requestManualSearch?(
    input: AgentHttpInput<AgentManualSearchRequest>,
  ): Promise<AgentManualSearchResponse>;
  requestUserInfo?(input: AgentHttpInput<AgentUserInfoRequest>): Promise<AgentUserInfoResponse>;
  requestProfileShow?(
    input: AgentHttpInput<AgentProfileShowRequest>,
  ): Promise<AgentProfileShowResponse>;
  requestProfileUpdate?(
    input: AgentHttpInput<AgentProfileUpdateRequest>,
  ): Promise<AgentProfileUpdateResponse>;
  requestAppConfigGet?(
    input: AgentHttpInput<AgentAppConfigGetRequest>,
  ): Promise<AgentAppConfigResponse>;
  requestAppConfigUpdate?(
    input: AgentHttpInput<AgentAppConfigUpdateRequest>,
  ): Promise<AgentAppConfigResponse>;
  requestLabelList?(input: AgentHttpInput<Record<string, never>>): Promise<AgentLabelListResponse>;
}

function manualRequestError(errorCode: string, message: string, status: number): Error {
  return new AgentManualRequestError(errorCode as AgentManualErrorCode, message, status);
}

function profileRequestError(errorCode: string, message: string, status: number): Error {
  return new AgentProfileRequestError(errorCode as AgentProfileErrorCode, message, status);
}

const appConfigError = (errorCode: string, message: string, status: number) =>
  new AgentAppConfigRequestError(errorCode as AgentAppConfigErrorCode, message, status);

const plainError = (_errorCode: string, message: string) => new Error(message);

export const createAgentWorkspaceHttpClient = (
  httpClient: HttpFetch,
): AgentWorkspaceHttpClient => ({
  async requestWorkspaceInfo({ request, ...keys }) {
    const data = await getAgentJson<Omit<WorkspaceInfoResponse, "idempotencyKey">>(httpClient, {
      ...keys,
      what: "workspace_info",
      query: {},
    });
    return { ...data, idempotencyKey: request.idempotencyKey };
  },
  requestManualGet: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentManualGetResponse>(
      httpClient,
      {
        ...keys,
        what: "agent manual get",
        query: { topic: request.topic, intent: request.intent, reason: request.reason },
      },
      manualRequestError,
    ),
  requestManualSearch: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentManualSearchResponse>(
      httpClient,
      {
        ...keys,
        what: "agent manual search",
        query: { query: request.query, intent: request.intent, reason: request.reason },
      },
      manualRequestError,
    ),
  requestUserInfo: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentUserInfoResponse>(
      httpClient,
      { ...keys, what: "agent user info", query: {} },
      (errorCode, message, status) =>
        new AgentUserInfoRequestError(errorCode as AgentUserInfoErrorCode, message, status),
    ),
  requestProfileShow: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentProfileShowResponse>(
      httpClient,
      { ...keys, what: "agent profile show", query: { target: request.target } },
      profileRequestError,
    ),
  requestProfileUpdate: ({ request, ...keys }) =>
    postAgentEnvelopeJson<AgentProfileUpdateResponse>(
      httpClient,
      { ...keys, what: "agent profile update", body: request },
      profileRequestError,
    ),
  requestAppConfigGet: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentAppConfigResponse>(
      httpClient,
      { ...keys, what: "agent app config get", query: {} },
      appConfigError,
    ),
  // The App is the URL's; the body is the change alone.
  requestAppConfigUpdate: ({ request: { appId: _appId, ...change }, ...keys }) =>
    postAgentEnvelopeJson<AgentAppConfigResponse>(
      httpClient,
      { ...keys, what: "agent app config update", method: "PATCH", body: change },
      appConfigError,
    ),
  requestLabelList: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentLabelListResponse>(
      httpClient,
      { ...keys, what: "agent label list", query: {} },
      plainError,
    ),
});
