import { RedisClient } from "bun";
import { redisUrlFor } from "#src/server/redis-url.server";
import {
  decodeAgentWorkspaceFileReadResult,
  decodeAgentWorkspaceFilesListResult,
  decodeAgentWorkspaceDeleteResult,
  encodeAgentWorkspaceFileReadResult,
  encodeAgentWorkspaceFilesListResult,
  encodeAgentWorkspaceDeleteResult,
  type AgentWorkspaceFileReadRequest,
  type AgentWorkspaceFileReadResult,
  type AgentWorkspaceFilesListRequest,
  type AgentWorkspaceFilesListResult,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameWorkspaceFileReadScope,
  sameWorkspaceFilesListScope,
  sameWorkspaceDeleteScope,
  type AgentWorkspaceFileReadResults,
  type AgentWorkspaceFilesListResults,
  type PendingWorkspaceFileRead,
  type PendingWorkspaceFilesList,
  type AgentWorkspaceDeleteResults,
  type PendingWorkspaceDelete,
} from "#src/server/agents/agent-workspace-files.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:agent-workspace-files:v1";
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;

export class RedisAgentWorkspaceFilesListResults
  extends RedisPendingResults<
    AgentWorkspaceFilesListRequest,
    AgentWorkspaceFilesListResult,
    PendingWorkspaceFilesList
  >
  implements AgentWorkspaceFilesListResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: `${PREFIX}:list`,
      encode: encodeAgentWorkspaceFilesListResult,
      decode: decodeAgentWorkspaceFilesListResult,
      sameScope: sameWorkspaceFilesListScope,
    });
  }
}

export class RedisAgentWorkspaceFileReadResults
  extends RedisPendingResults<
    AgentWorkspaceFileReadRequest,
    AgentWorkspaceFileReadResult,
    PendingWorkspaceFileRead
  >
  implements AgentWorkspaceFileReadResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: `${PREFIX}:read`,
      encode: encodeAgentWorkspaceFileReadResult,
      decode: decodeAgentWorkspaceFileReadResult,
      sameScope: sameWorkspaceFileReadScope,
    });
  }
}

export class RedisAgentWorkspaceDeleteResults
  extends RedisPendingResults<
    AgentWorkspaceDeleteRequest,
    AgentWorkspaceDeleteResult,
    PendingWorkspaceDelete
  >
  implements AgentWorkspaceDeleteResults
{
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: `${PREFIX}:delete`,
      encode: encodeAgentWorkspaceDeleteResult,
      decode: decodeAgentWorkspaceDeleteResult,
      sameScope: sameWorkspaceDeleteScope,
    });
  }
}

let listSingleton: RedisAgentWorkspaceFilesListResults | undefined;
let readSingleton: RedisAgentWorkspaceFileReadResults | undefined;
let deleteSingleton: RedisAgentWorkspaceDeleteResults | undefined;

export function getAgentWorkspaceFilesListResults() {
  if (!listSingleton)
    listSingleton = new RedisAgentWorkspaceFilesListResults(
      new RedisClient(redisUrlFor("Workspace Files queries")),
    );
  return listSingleton;
}

export function getAgentWorkspaceFileReadResults() {
  if (!readSingleton)
    readSingleton = new RedisAgentWorkspaceFileReadResults(
      new RedisClient(redisUrlFor("Workspace Files queries")),
    );
  return readSingleton;
}

export function getAgentWorkspaceDeleteResults() {
  if (!deleteSingleton)
    deleteSingleton = new RedisAgentWorkspaceDeleteResults(
      new RedisClient(redisUrlFor("Workspace Files queries")),
    );
  return deleteSingleton;
}

export function createAgentWorkspaceFilesListResultMethod(
  results?: Pick<RedisAgentWorkspaceFilesListResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentWorkspaceFilesListResult(payload);
    if (
      !principal.userId ||
      principal.agentId ||
      principal.workspaceId !== result.workspaceId ||
      principal.computerId !== result.computerId
    )
      return { code: 403, message: "Workspace Files list result scope is not authorized" };
    await (results ?? getAgentWorkspaceFilesListResults()).accept(result);
    return new Uint8Array();
  };
}

export function createAgentWorkspaceFileReadResultMethod(
  results?: Pick<RedisAgentWorkspaceFileReadResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentWorkspaceFileReadResult(payload);
    if (
      !principal.userId ||
      principal.agentId ||
      principal.workspaceId !== result.workspaceId ||
      principal.computerId !== result.computerId
    )
      return { code: 403, message: "Workspace file read result scope is not authorized" };
    await (results ?? getAgentWorkspaceFileReadResults()).accept(result);
    return new Uint8Array();
  };
}

export function createAgentWorkspaceDeleteResultMethod(
  results?: Pick<RedisAgentWorkspaceDeleteResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentWorkspaceDeleteResult(payload);
    if (
      !principal.userId ||
      principal.agentId ||
      principal.workspaceId !== result.workspaceId ||
      principal.computerId !== result.computerId
    )
      return { code: 403, message: "Workspace delete result scope is not authorized" };
    await (results ?? getAgentWorkspaceDeleteResults()).accept(result);
    return new Uint8Array();
  };
}
