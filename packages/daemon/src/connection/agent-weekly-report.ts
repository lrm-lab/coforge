import type { WeeklyReportRequest, WeeklyReportResponse } from "@lrm/coforge-sdk/internal";
export type { WeeklyReportRequest, WeeklyReportResponse } from "@lrm/coforge-sdk/internal";
export type {
  WeeklyReportCollectCommand,
  WeeklyReportCollectFailRunningCommand,
  WeeklyReportCollectResult,
} from "./weekly-report-collect";
export type {
  WeeklyReportKeyPointsCommand,
  WeeklyReportKeyPointsResult,
} from "./weekly-report-key-points";
export type { WeeklyReportMemoryCommand, WeeklyReportMemoryResult } from "./weekly-report-memory";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import {
  defaultAgentWeeklyReportCollectHttpClient,
  defaultAgentWeeklyReportKeyPointsHttpClient,
  defaultAgentWeeklyReportMemoryHttpClient,
  type AgentWeeklyReportHttpClient,
} from "./agent-http-clients";
import type {
  WeeklyReportCollectCommand,
  WeeklyReportCollectFailRunningCommand,
  WeeklyReportCollectResult,
} from "./weekly-report-collect";
import type {
  WeeklyReportKeyPointsCommand,
  WeeklyReportKeyPointsResult,
} from "./weekly-report-key-points";
import type { WeeklyReportMemoryCommand, WeeklyReportMemoryResult } from "./weekly-report-memory";

/** What the four weekly-report forwards need from the connection that owns them. */
export type WeeklyReportPorts = {
  assertConnected(): void;
  endpoint(what: string, path: string): string;
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
  client: AgentWeeklyReportHttpClient;
};

/** `coforge weekly-report`: the report itself. */
export function weeklyReport(
  ports: WeeklyReportPorts,
  request: WeeklyReportRequest,
  agentApiKey: string,
): Promise<WeeklyReportResponse> {
  ports.assertConnected();
  return ports.client.request({
    url: ports.endpoint("Agent weekly-report HTTP", agentApiRoutes.cloud.weeklyReports.path),
    ...ports.keys(agentApiKey),
    request,
  });
}

/** `coforge weekly-report-collect`: a Collect Run's pack. */
export function weeklyReportCollect(
  ports: WeeklyReportPorts,
  request: WeeklyReportCollectCommand | WeeklyReportCollectFailRunningCommand,
  agentApiKey: string,
): Promise<WeeklyReportCollectResult> {
  ports.assertConnected();
  return defaultAgentWeeklyReportCollectHttpClient.execute({
    url: ports.endpoint(
      "Agent weekly-report-collect HTTP",
      agentApiRoutes.cloud.weeklyReportCollect.path,
    ),
    ...ports.keys(agentApiKey),
    request,
  });
}

/** `coforge weekly-report-key-points`: the report's key points. */
export function weeklyReportKeyPoints(
  ports: WeeklyReportPorts,
  request: WeeklyReportKeyPointsCommand,
  agentApiKey: string,
): Promise<WeeklyReportKeyPointsResult> {
  ports.assertConnected();
  return defaultAgentWeeklyReportKeyPointsHttpClient.execute({
    url: ports.endpoint(
      "Agent weekly-report-key-points HTTP",
      agentApiRoutes.cloud.weeklyReportKeyPoints.path,
    ),
    ...ports.keys(agentApiKey),
    request,
  });
}

/** `coforge weekly-report-memory`: the settlement a collector submits. */
export function weeklyReportMemory(
  ports: WeeklyReportPorts,
  request: WeeklyReportMemoryCommand,
  agentApiKey: string,
): Promise<WeeklyReportMemoryResult> {
  ports.assertConnected();
  return defaultAgentWeeklyReportMemoryHttpClient.execute({
    url: ports.endpoint(
      "Agent weekly-report-memory HTTP",
      agentApiRoutes.cloud.weeklyReportMemory.path,
    ),
    ...ports.keys(agentApiKey),
    request,
  });
}
