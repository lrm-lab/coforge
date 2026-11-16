import { randomBytes, timingSafeEqual } from "node:crypto";

export const EXTERNAL_AGENT_KEY_PREFIX = "sk_ext_";
const EXTERNAL_AGENT_KEY = /^sk_ext_[A-Za-z0-9_-]{43}$/;

export const MAX_LIVE_EXTERNAL_CREDENTIALS = 10;
export const EXTERNAL_LAST_USED_INTERVAL_MS = 60 * 60 * 1000;

export type ExternalCredentialRevokeReason =
  | "logout"
  | "revoked"
  | "revoke_all"
  | "agent_deleted"
  | "agent_stopped";

export type ExternalMachine = {
  machineName: string;
  hostname: string;
  os: string;
  clientName: string;
};

export type ExternalCredentialMintRefusal =
  | "agent_unavailable"
  | "agent_not_external"
  | "credential_limit";

export type ExternalCredentialAuthFailure = "key_not_found" | "key_revoked" | "agent_unavailable";

export type ExternalCredentialRecord = {
  id: string;
  keyHash: string;
  agentId: string;
  workspaceId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  agent: {
    ownerId: string;
    deletedAt: Date | null;
    stoppedAt: Date | null;
    hosting: string;
  };
};

export type ExternalCredentialSummary = ExternalMachine & {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

export type ExternalAgentPrincipal = {
  external: true;
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  credentialId: string;
};

export function isExternalAgentPrincipal(principal: {
  workspaceId: string;
  agentId: string;
}): principal is ExternalAgentPrincipal {
  return "external" in principal && principal.external === true;
}

export class ExternalCredentialError extends Error {
  constructor(readonly reason: ExternalCredentialAuthFailure) {
    super("invalid external Agent credential");
    this.name = "ExternalCredentialError";
  }
}

export interface ExternalAgentCredentialRepository {
  mint(input: {
    agentId: string;
    workspaceId: string;
    approvedByUserId: string | null;
    keyHash: string;
    machine: ExternalMachine;
    maxLive: number;
  }): Promise<{ ok: true; id: string } | { ok: false; reason: ExternalCredentialMintRefusal }>;
  findByHash(hash: string): Promise<ExternalCredentialRecord | undefined>;
  touch(id: string, at: Date, notAfter: Date): Promise<void>;
  revoke(
    id: string,
    reason: ExternalCredentialRevokeReason,
    at: Date,
    agentId?: string,
  ): Promise<boolean>;
  revokeAll(
    agentId: string,
    reason: ExternalCredentialRevokeReason,
    at: Date,
  ): Promise<{ count: number }>;
  list(agentId: string): Promise<ExternalCredentialSummary[]>;
}

export function hashExternalAgentKey(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function generateExternalAgentKey(): string {
  return `${EXTERNAL_AGENT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isExternalAgentKeyShape(value: string): boolean {
  return EXTERNAL_AGENT_KEY.test(value);
}

export function auditExternalCredential(
  event: string,
  fields: Record<string, string | number | null | undefined>,
): void {
  console.info(JSON.stringify({ event: `external_agent.${event}`, ...fields }));
}

export async function mintExternalAgentCredential(input: {
  repository: ExternalAgentCredentialRepository;
  agentId: string;
  workspaceId: string;
  approvedByUserId: string | null;
  machine: ExternalMachine;
}): Promise<
  | { ok: true; credentialId: string; apiKey: string }
  | { ok: false; reason: ExternalCredentialMintRefusal }
> {
  const apiKey = generateExternalAgentKey();
  const minted = await input.repository.mint({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    approvedByUserId: input.approvedByUserId,
    keyHash: hashExternalAgentKey(apiKey),
    machine: input.machine,
    maxLive: MAX_LIVE_EXTERNAL_CREDENTIALS,
  });
  if (!minted.ok) {
    auditExternalCredential("credential_issue_refused", {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      reason: minted.reason,
    });
    return minted;
  }
  auditExternalCredential("credential_issued", {
    credentialId: minted.id,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    approvedByUserId: input.approvedByUserId,
  });
  return { ok: true, credentialId: minted.id, apiKey };
}

export async function authenticateExternalAgentKey(
  apiKey: string,
  repository: Pick<ExternalAgentCredentialRepository, "findByHash" | "touch">,
  now: () => number = Date.now,
): Promise<ExternalAgentPrincipal> {
  if (!EXTERNAL_AGENT_KEY.test(apiKey)) throw new ExternalCredentialError("key_not_found");
  const actual = Buffer.from(hashExternalAgentKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record) throw new ExternalCredentialError("key_not_found");
  const expected = Buffer.from(record.keyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ExternalCredentialError("key_not_found");
  if (record.revokedAt) throw new ExternalCredentialError("key_revoked");
  const { agent } = record;
  if (agent.deletedAt || agent.stoppedAt || agent.hosting !== "external")
    throw new ExternalCredentialError("agent_unavailable");
  const at = now();
  const lastUsed = record.lastUsedAt?.getTime();
  if (lastUsed === undefined || at - lastUsed >= EXTERNAL_LAST_USED_INTERVAL_MS)
    await repository
      .touch(record.id, new Date(at), new Date(at - EXTERNAL_LAST_USED_INTERVAL_MS))
      .catch(() => {});
  return {
    external: true,
    userId: agent.ownerId,
    workspaceId: record.workspaceId,
    computerId: "",
    agentId: record.agentId,
    credentialId: record.id,
  };
}

export async function revokeSelfExternalCredential(
  repository: Pick<ExternalAgentCredentialRepository, "revoke">,
  principal: { credentialId: string; agentId: string; workspaceId: string },
  now: () => number = Date.now,
): Promise<boolean> {
  const revoked = await repository.revoke(principal.credentialId, "logout", new Date(now()));
  if (revoked)
    auditExternalCredential("credential_revoked", {
      credentialId: principal.credentialId,
      agentId: principal.agentId,
      workspaceId: principal.workspaceId,
      reason: "logout",
    });
  return revoked;
}

export async function revokeOneExternalCredential(
  repository: Pick<ExternalAgentCredentialRepository, "revoke">,
  input: { credentialId: string; agentId: string; workspaceId: string },
  now: () => number = Date.now,
): Promise<boolean> {
  const revoked = await repository.revoke(
    input.credentialId,
    "revoked",
    new Date(now()),
    input.agentId,
  );
  if (revoked)
    auditExternalCredential("credential_revoked", {
      credentialId: input.credentialId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      reason: "revoked",
    });
  return revoked;
}

export async function revokeAllExternalCredentials(
  repository: Pick<ExternalAgentCredentialRepository, "revokeAll">,
  input: { agentId: string; workspaceId: string; reason: ExternalCredentialRevokeReason },
  now: () => number = Date.now,
): Promise<number> {
  const { count } = await repository.revokeAll(input.agentId, input.reason, new Date(now()));
  if (count > 0)
    auditExternalCredential("credentials_revoked", {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      reason: input.reason,
      count,
    });
  return count;
}

export function listExternalCredentials(
  repository: Pick<ExternalAgentCredentialRepository, "list">,
  agentId: string,
): Promise<ExternalCredentialSummary[]> {
  return repository.list(agentId);
}
