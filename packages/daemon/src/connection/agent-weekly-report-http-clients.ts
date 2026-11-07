import type { WeeklyReportRequest, WeeklyReportResponse } from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "./agent-transport-error";
import { AgentWeeklyReportRequestError } from "./agent-weekly-report-request-error";
import {
  AGENT_RPC_TIMEOUT_MS,
  agentHeaders,
  type AgentHttpInput,
} from "./agent-http-wire";

export interface AgentWeeklyReportHttpClient {
  request(input: AgentHttpInput<WeeklyReportRequest>): Promise<WeeklyReportResponse>;
}
export interface AgentWeeklyReportCollectHttpClient {
  execute(
    input: AgentHttpInput<
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand
    >,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult>;
}
export interface AgentWeeklyReportKeyPointsHttpClient {
  execute(
    input: AgentHttpInput<import("./weekly-report-key-points").WeeklyReportKeyPointsCommand>,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult>;
}
export interface AgentWeeklyReportMemoryHttpClient {
  execute(
    input: AgentHttpInput<import("./weekly-report-memory").WeeklyReportMemoryCommand>,
  ): Promise<import("./weekly-report-memory").WeeklyReportMemoryResult>;
}

export const defaultAgentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = {
  async request({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 400 || response.status === 403)
        throw new AgentWeeklyReportRequestError(
          message.trim() ||
            (response.status === 403
              ? "Weekly report access denied"
              : "invalid weekly-report request"),
        );
      throw new Error(`server Agent weekly-report request failed (${response.status})`);
    }
    const result = (await response.json()) as WeeklyReportResponse;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportCollectHttpClient: AgentWeeklyReportCollectHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-collect", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-collect",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-collect").WeeklyReportCollectResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-collect response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportKeyPointsHttpClient: AgentWeeklyReportKeyPointsHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-key-points", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-key-points",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-key-points").WeeklyReportKeyPointsResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-key-points response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportMemoryHttpClient: AgentWeeklyReportMemoryHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-memory", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse("Agent weekly-report-memory", response.status);
    const result =
      (await response.json()) as import("./weekly-report-memory").WeeklyReportMemoryResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-memory response idempotency key does not match request");
    return result;
  },
};
