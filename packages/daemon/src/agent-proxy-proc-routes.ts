import {
  agentApiRoutes,
  decodeAgentProcLogsRequest,
  decodeAgentProcStartRequest,
  decodeAgentProcStopRequest,
} from "@lrm/coforge-sdk/agent";
import { ProcJobError } from "#src/proc-jobs/proc-job-error";
import { exactPath } from "./agent-proxy-paths";
import { defineRoute, type ProxyRoute } from "./agent-proxy-route";

function parseOptionalIntQuery(url: URL, key: string): number | undefined {
  if (!url.searchParams.has(key)) return undefined;
  const raw = url.searchParams.get(key) ?? "";
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${key}`);
  return Number(raw);
}

function procDomainFailure(error: unknown): Response | undefined {
  if (!(error instanceof ProcJobError)) return undefined;
  return Response.json(
    {
      ok: false,
      errorCode: error.errorCode,
      error: error.message,
      ...(error.jobs ? { jobs: error.jobs } : {}),
    },
    { status: error.status },
  );
}

export const PROC_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/proc-list",
    method: agentApiRoutes.proxy.proc.list.method,
    match: exactPath(agentApiRoutes.proxy.proc.list.path),
    body: "none",
    handler: "procList",
    parse: () => ({}),
    domainFailure: procDomainFailure,
  }),
  defineRoute({
    family: "agent-api/proc-logs",
    method: agentApiRoutes.proxy.proc.logs.method,
    match: exactPath(agentApiRoutes.proxy.proc.logs.path),
    body: "none",
    handler: "procLogs",
    parse: ({ url }) => {
      const tail = parseOptionalIntQuery(url, "tail");
      const offset = parseOptionalIntQuery(url, "offset");
      return decodeAgentProcLogsRequest({
        name: url.searchParams.get("name") ?? "",
        ...(tail !== undefined ? { tail } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
    },
    domainFailure: procDomainFailure,
  }),
  defineRoute({
    family: "agent-api/proc-start",
    method: agentApiRoutes.proxy.proc.start.method,
    match: exactPath(agentApiRoutes.proxy.proc.start.path),
    body: "json-object",
    maxBodyBytes: agentApiRoutes.proxy.proc.start.maxBodyBytes,
    handler: "procStart",
    parse: ({ fields }) => decodeAgentProcStartRequest(fields),
    domainFailure: procDomainFailure,
  }),
  defineRoute({
    family: "agent-api/proc-stop",
    method: agentApiRoutes.proxy.proc.stop.method,
    match: exactPath(agentApiRoutes.proxy.proc.stop.path),
    body: "json-object",
    handler: "procStop",
    parse: ({ fields }) => decodeAgentProcStopRequest(fields),
    domainFailure: procDomainFailure,
  }),
];
