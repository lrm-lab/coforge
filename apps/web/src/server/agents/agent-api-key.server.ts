import { randomBytes, timingSafeEqual } from "node:crypto";

export type AgentApiKeyRecord = {
  id: string;
  apiKeyHash: string;
  agentId: string;
  workspaceId: string;
  ownerId: string;
  computerId: string;
  revokedAt: Date | null;
  disabledAt: Date | null;
  firstUsedAt: Date | null;
  createdAt: Date;
};

const AGENT_API_KEY = /^sk_agent_[A-Za-z0-9_-]{43}$/;

export type AgentApiKeyAuthFailure =
  | "key_not_found"
  | "key_revoked"
  | "scope_mismatch"
  | "daemon_key_invalid"
  | "internal";

export class AgentApiKeyError extends Error {
  constructor(readonly reason: AgentApiKeyAuthFailure) {
    super("invalid Agent API key");
    this.name = "AgentApiKeyError";
  }
}

export type AgentApiKeyMintInput = Omit<AgentApiKeyRecord, "id" | "createdAt">;

export interface AgentApiKeyRepository {
  rotate(record: AgentApiKeyMintInput): Promise<void>;
  findByHash(hash: string): Promise<AgentApiKeyRecord | undefined>;
  revokeOlderKeys(record: AgentApiKeyRecord): Promise<void>;
  revoke(id: string): Promise<void>;
  revokeAll(record: AgentApiKeyRecord): Promise<void>;
}

export function isAgentApiKeyBoundToComputer(
  record: Pick<AgentApiKeyRecord, "workspaceId" | "computerId">,
  daemon: { workspaceId: string; computerId: string },
): boolean {
  return record.workspaceId === daemon.workspaceId && record.computerId === daemon.computerId;
}

export function hashAgentApiKey(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function generateAgentApiKey(prefix = "sk_agent_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function agentKeyHashMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAgentApiKeyShape(value: string): boolean {
  return AGENT_API_KEY.test(value);
}

export function createAgentApiKey(input: {
  agentId: string;
  workspaceId: string;
  ownerId: string;
  computerId: string;
  repository: AgentApiKeyRepository;
}): Promise<string> {
  const apiKey = generateAgentApiKey();
  return input.repository
    .rotate({
      apiKeyHash: hashAgentApiKey(apiKey),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      computerId: input.computerId,
      revokedAt: null,
      disabledAt: null,
      firstUsedAt: null,
    })
    .then(() => apiKey);
}

export async function authenticateAgentApiKey(
  apiKey: string,
  repository: AgentApiKeyRepository,
): Promise<AgentApiKeyRecord> {
  if (!AGENT_API_KEY.test(apiKey)) throw new AgentApiKeyError("key_not_found");
  const actual = hashAgentApiKey(apiKey);
  const record = await repository.findByHash(actual);
  if (!record) throw new AgentApiKeyError("key_not_found");
  if (record.revokedAt || record.disabledAt) throw new AgentApiKeyError("key_revoked");
  if (!agentKeyHashMatches(record.apiKeyHash, actual)) throw new AgentApiKeyError("key_not_found");
  return record;
}

export async function settleAgentApiKeyFirstUse(
  record: AgentApiKeyRecord,
  repository: AgentApiKeyRepository,
): Promise<void> {
  if (record.firstUsedAt) return;
  await repository.revokeOlderKeys(record);
}

export async function findAgentApiKey(
  apiKey: string,
  repository: AgentApiKeyRepository,
): Promise<AgentApiKeyRecord> {
  if (!AGENT_API_KEY.test(apiKey)) throw new Error("invalid Agent API key");
  const actual = hashAgentApiKey(apiKey);
  const record = await repository.findByHash(actual);
  if (!record || !agentKeyHashMatches(record.apiKeyHash, actual))
    throw new Error("invalid Agent API key");
  return record;
}
