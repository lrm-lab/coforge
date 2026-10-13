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
};

const AGENT_API_KEY = /^sk_agent_[A-Za-z0-9_-]{43}$/;

/** What minting supplies for `replaceActive`: the Prisma client generates the id
 * from the schema default (`uuid(7)`), keeping one id-generation path for the project. */
export type AgentApiKeyMintInput = Omit<AgentApiKeyRecord, "id">;

export interface AgentApiKeyRepository {
  replaceActive(record: AgentApiKeyMintInput): Promise<void>;
  findByHash(hash: string): Promise<AgentApiKeyRecord | undefined>;
  revoke(id: string): Promise<void>;
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

export function createAgentApiKey(input: {
  agentId: string;
  workspaceId: string;
  ownerId: string;
  computerId: string;
  repository: AgentApiKeyRepository;
}): Promise<string> {
  const apiKey = `sk_agent_${randomBytes(32).toString("base64url")}`;
  // No explicit id: the Prisma client generates it from the schema's uuid(7)
  // default — API keys keep the project's one id-generation path end to end.
  return input.repository
    .replaceActive({
      apiKeyHash: hashAgentApiKey(apiKey),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      computerId: input.computerId,
      revokedAt: null,
      disabledAt: null,
    })
    .then(() => apiKey);
}

export async function authenticateAgentApiKey(
  apiKey: string,
  repository: AgentApiKeyRepository,
): Promise<AgentApiKeyRecord> {
  if (!AGENT_API_KEY.test(apiKey)) throw new Error("invalid Agent API key");
  const actual = Buffer.from(hashAgentApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record || record.revokedAt || record.disabledAt) throw new Error("invalid Agent API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Agent API key");
  return record;
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
