import { TEAM_MEMORY_ROUTE, decodeTeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import { forwardResponse } from "./agent-proxy-response";
import { LOCAL_MEMORY_ROUTE, decodeLocalMemoryCommand } from "@lrm/coforge-sdk/agent";
import { exactPath } from "./agent-proxy-paths";
import { defineRoute } from "./agent-proxy-route";

export const LOCAL_MEMORY_PROXY_ROUTE = defineRoute({
  family: "agent-api/local-memory",
  method: LOCAL_MEMORY_ROUTE.method,
  match: exactPath(LOCAL_MEMORY_ROUTE.path),
  body: "json-object",
  handler: "agentMemory",
  parse: ({ fields }) => decodeLocalMemoryCommand(fields),
  domainFailure: (error) => {
    const code = error instanceof Error ? error.message : "";
    if (!code.startsWith("memory_")) return undefined;
    return Response.json(
      { ok: false, errorCode: code, error: code },
      { status: code === "memory_conflict" ? 409 : code === "memory_not_found" ? 404 : 400 },
    );
  },
});

export const TEAM_MEMORY_PROXY_ROUTE = defineRoute({
  family: "agent-api/team-memory",
  method: TEAM_MEMORY_ROUTE.method,
  match: exactPath(TEAM_MEMORY_ROUTE.path),
  body: "json-object",
  maxBodyBytes: 96 * 1024,
  handler: "agentTeamMemory",
  parse: ({ fields }) => decodeTeamMemoryCommand(fields),
  respond: forwardResponse,
});
