import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { type WeeklyReportCommand, type WeeklyReportResponse } from "@lrm/coforge-sdk/internal";
import { isAgentCredential } from "./agent-credential";

async function weeklyReportPost<TResponse>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  route: { path: string; method: string },
  label: string,
  timeoutMs: number,
  command: unknown,
): Promise<TResponse> {
  if (!context || !isAgentCredential(context)) throw new Error("coforge agent context is invalid");
  if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
  const response = await fetch(proxyEndpoint(route.path), {
    method: route.method,
    headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`agent ${label} request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as TResponse;
}

export function weeklyReportRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  command: WeeklyReportCommand,
): Promise<WeeklyReportResponse> {
  return weeklyReportPost(
    proxyEndpoint,
    context,
    proxyUrl,
    agentApiRoutes.proxy.weeklyReports,
    "weekly-report",
    10_000,
    command,
  );
}

export function weeklyReportCollectRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  command: import("../index").WeeklyReportCollectCommand,
): Promise<import("../index").WeeklyReportCollectResult> {
  return weeklyReportPost(
    proxyEndpoint,
    context,
    proxyUrl,
    agentApiRoutes.proxy.weeklyReportCollect,
    "weekly-report-collect",
    60_000,
    command,
  );
}

export function weeklyReportKeyPointsRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  command: import("../index").WeeklyReportKeyPointsCommand,
): Promise<import("../index").WeeklyReportKeyPointsResult> {
  return weeklyReportPost(
    proxyEndpoint,
    context,
    proxyUrl,
    agentApiRoutes.proxy.weeklyReportKeyPoints,
    "weekly-report-key-points",
    60_000,
    command,
  );
}

export function weeklyReportMemoryRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  command: import("../index").WeeklyReportMemoryCommand,
): Promise<import("../index").WeeklyReportMemoryResult> {
  return weeklyReportPost(
    proxyEndpoint,
    context,
    proxyUrl,
    agentApiRoutes.proxy.weeklyReportMemory,
    "weekly-report-memory",
    60_000,
    command,
  );
}
