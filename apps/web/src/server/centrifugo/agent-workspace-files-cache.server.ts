import { RedisClient } from "bun";
import { redisUrlFor } from "#src/server/redis-url.server";
import {
  decodeAgentWorkspaceFileReadResult,
  decodeAgentWorkspaceFilesListResult,
  decodeAgentWorkspaceDeleteResult,
  encodeAgentWorkspaceFileReadResult,
  encodeAgentWorkspaceFilesListResult,
  encodeAgentWorkspaceDeleteResult,
  type AgentWorkspaceFileReadResult,
  type AgentWorkspaceFilesListResult,
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

// Same atomic-accept shape as Skills: compare the entire pending value so expiry/cancellation
// cannot race the result write, and the first valid result wins.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', 30, 'NX') and 1 or 0`;

const PREFIX = "coforge:agent-workspace-files:v1";

export class RedisAgentWorkspaceFilesListResults implements AgentWorkspaceFilesListResults {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}
  private keys(id: string) {
    return [`${PREFIX}:list:${id}:pending`, `${PREFIX}:list:${id}:result`];
  }
  async begin(pending: PendingWorkspaceFilesList) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      "30",
    );
  }
  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? decodeAgentWorkspaceFilesListResult(Buffer.from(value, "base64")) : undefined;
  }
  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }
  async accept(result: AgentWorkspaceFilesListResult) {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return;
    const pending = JSON.parse(value) as PendingWorkspaceFilesList;
    if (!sameWorkspaceFilesListScope(pending.request, result)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(encodeAgentWorkspaceFilesListResult(result)).toString("base64"),
    ]);
  }
}

export class RedisAgentWorkspaceFileReadResults implements AgentWorkspaceFileReadResults {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}
  private keys(id: string) {
    return [`${PREFIX}:read:${id}:pending`, `${PREFIX}:read:${id}:result`];
  }
  async begin(pending: PendingWorkspaceFileRead) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      "30",
    );
  }
  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? decodeAgentWorkspaceFileReadResult(Buffer.from(value, "base64")) : undefined;
  }
  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }
  async accept(result: AgentWorkspaceFileReadResult) {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return;
    const pending = JSON.parse(value) as PendingWorkspaceFileRead;
    if (!sameWorkspaceFileReadScope(pending.request, result)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(encodeAgentWorkspaceFileReadResult(result)).toString("base64"),
    ]);
  }
}

export class RedisAgentWorkspaceDeleteResults implements AgentWorkspaceDeleteResults {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}
  private keys(id: string) {
    return [`${PREFIX}:delete:${id}:pending`, `${PREFIX}:delete:${id}:result`];
  }
  async begin(pending: PendingWorkspaceDelete) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      "30",
    );
  }
  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? decodeAgentWorkspaceDeleteResult(Buffer.from(value, "base64")) : undefined;
  }
  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }
  async accept(result: AgentWorkspaceDeleteResult) {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return;
    const pending = JSON.parse(value) as PendingWorkspaceDelete;
    if (!sameWorkspaceDeleteScope(pending.request, result)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(encodeAgentWorkspaceDeleteResult(result)).toString("base64"),
    ]);
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
