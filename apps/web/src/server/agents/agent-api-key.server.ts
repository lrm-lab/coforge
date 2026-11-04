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

/** Why an Agent credential was refused; logged on the 401. Key material is never logged. */
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

/** What minting supplies for `rotate`: the Prisma client generates the id and `createdAt`
 * from the schema defaults (`uuid(7)`, `now()`), keeping one id-generation path for the project. */
export type AgentApiKeyMintInput = Omit<AgentApiKeyRecord, "id" | "createdAt">;

export interface AgentApiKeyRepository {
  /** Mints `record` under the Agent row lock, keeping the newest earlier active key valid
   * (overlap rotation) and revoking anything older. */
  rotate(record: AgentApiKeyMintInput): Promise<void>;
  findByHash(hash: string): Promise<AgentApiKeyRecord | undefined>;
  /** Revokes the Agent's other active keys older than `record`; a no-op when none exist. */
  revokeOlderKeys(record: AgentApiKeyRecord): Promise<void>;
  /** Revokes exactly the key `id` names — a failed launch drops only its own mint. */
  revoke(id: string): Promise<void>;
  /** Revokes every active key of `record`'s Agent — a Stop ends the whole overlap window. */
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

/** A new key in the one Agent API key format. Callers store only `hashAgentApiKey` of it. */
export function generateAgentApiKey(): string {
  return `sk_agent_${randomBytes(32).toString("base64url")}`;
}

/** Whether `value` is shaped like an Agent API key (a daemon's or a bot's). */
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
  // No explicit id or createdAt: the Prisma client generates them from the schema's
  // defaults — API keys keep the project's one id-generation path end to end.
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
  const actual = Buffer.from(hashAgentApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record) throw new AgentApiKeyError("key_not_found");
  if (record.revokedAt || record.disabledAt) throw new AgentApiKeyError("key_revoked");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AgentApiKeyError("key_not_found");
  return record;
}

/** Overlap rotation settlement: the first successful authentication marks the key used and
 * retires every older key. The update is conditional on `record` being newer, so an older
 * key's own request cannot retire a newer one. Callers run it only after every scope check
 * has passed, so a refused request retires nothing, and only once per key — later requests
 * see `firstUsedAt` set and skip the write entirely. */
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
  const actual = Buffer.from(hashAgentApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record) throw new Error("invalid Agent API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Agent API key");
  return record;
}
