import { AppError } from "#src/lib/app-error";
import {
  EXTERNAL_MINT_REFUSAL,
  admitExternalMint,
  type ExternalMintRateLimits,
} from "./external-agent-mint-rate-limit.server";
import { agentKeyHashMatches, generateAgentApiKey, hashAgentApiKey } from "./agent-api-key.server";

export const EXTERNAL_AGENT_KEY_PREFIX = "sk_ext_";
const EXTERNAL_AGENT_KEY = /^sk_ext_[A-Za-z0-9_-]{43}$/;

export const MAX_LIVE_EXTERNAL_CREDENTIALS = 50;
export const EXTERNAL_LAST_USED_INTERVAL_MS = 30 * 1000;

export type ExternalCredentialRevokeReason =
  | "logout"
  | "revoked"
  | "agent_deleted"
  | "agent_stopped"
  | "replaced"
  | "issuer_password_reset";

export type ExternalCredentialSource = "device" | "app";

export type ExternalMachine = {
  machineName: string;
  hostname: string;
  os: string;
  clientName: string;
};

export type ExternalMachineSummary = { [Field in keyof ExternalMachine]: string | null };

export type ExternalCredentialMintRefusal =
  | "agent_unavailable"
  | "agent_not_external"
  | "credential_limit";

export type ExternalCredentialMintFailure =
  | { ok: false; reason: ExternalCredentialMintRefusal }
  | { ok: false; reason: typeof EXTERNAL_MINT_REFUSAL; retryAfterSeconds: number };

export type ExternalCredentialAuthFailure =
  | "key_not_found"
  | "key_revoked"
  | "agent_unavailable"
  | "issuer_left";

export type ExternalCredentialRecord = {
  id: string;
  keyHash: string;
  agentId: string;
  workspaceId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  issuerActive: boolean;
  agent: {
    ownerId: string;
    deletedAt: Date | null;
    stoppedAt: Date | null;
    hosting: string;
    visibility: string;
  };
};

export type ExternalCredentialSummary = ExternalMachineSummary & {
  id: string;
  source: ExternalCredentialSource;
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

export type ExternalSeenNotifier = (
  agent: { workspaceId: string; agentId: string; visibility: string },
  seenAtMs: number,
) => Promise<void>;

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
    source: ExternalCredentialSource;
    machine: ExternalMachine | null;
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
  list(agentId: string): Promise<ExternalCredentialSummary[]>;
  presence(agentIds: readonly string[]): Promise<ExternalPresenceRow[]>;
}

export type ExternalPresenceRow = {
  agentId: string;
  liveCount: number;
  liveLastUsedAt: Date | null;
  lastUsedAt: Date | null;
};

export const hashExternalAgentKey = hashAgentApiKey;

export function generateExternalAgentKey(): string {
  return generateAgentApiKey(EXTERNAL_AGENT_KEY_PREFIX);
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
  rateLimits: ExternalMintRateLimits;
  agentId: string;
  workspaceId: string;
  approvedByUserId: string | null;
  source: ExternalCredentialSource;
  machine: ExternalMachine | null;
}): Promise<{ ok: true; credentialId: string; apiKey: string } | ExternalCredentialMintFailure> {
  const admission = await admitExternalMint(input.rateLimits, {
    userId: input.approvedByUserId,
    agentId: input.agentId,
  });
  if (!admission.allowed) {
    auditExternalCredential("credential_issue_refused", {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      reason: EXTERNAL_MINT_REFUSAL,
      limit: admission.limit,
    });
    return {
      ok: false,
      reason: EXTERNAL_MINT_REFUSAL,
      retryAfterSeconds: admission.retryAfterSeconds,
    };
  }
  const apiKey = generateExternalAgentKey();
  const minted = await input.repository.mint({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    approvedByUserId: input.approvedByUserId,
    keyHash: hashExternalAgentKey(apiKey),
    source: input.source,
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
    source: input.source,
  });
  return { ok: true, credentialId: minted.id, apiKey };
}

export function mintRefusalError(refusal: ExternalCredentialMintFailure): AppError {
  if (refusal.reason === EXTERNAL_MINT_REFUSAL)
    return new AppError("RATE_LIMITED", {
      errorId: EXTERNAL_MINT_REFUSAL,
      details: { retryAfterSeconds: refusal.retryAfterSeconds },
    });
  return refusal.reason === "credential_limit"
    ? new AppError("CONFLICT", { errorId: "credential_limit" })
    : new AppError("NOT_FOUND");
}

export async function issueExternalAgentPageCredential(input: {
  repository: ExternalAgentCredentialRepository;
  rateLimits: ExternalMintRateLimits;
  agentId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<{ credentialId: string; key: string }> {
  const minted = await mintExternalAgentCredential({
    repository: input.repository,
    rateLimits: input.rateLimits,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    approvedByUserId: input.actorUserId,
    source: "app",
    machine: null,
  });
  if (!minted.ok) throw mintRefusalError(minted);
  return { credentialId: minted.credentialId, key: minted.apiKey };
}

export async function authenticateExternalAgentKey(
  apiKey: string,
  repository: Pick<ExternalAgentCredentialRepository, "findByHash" | "touch">,
  now: () => number = Date.now,
  onSeen?: ExternalSeenNotifier,
): Promise<ExternalAgentPrincipal> {
  if (!EXTERNAL_AGENT_KEY.test(apiKey)) throw new ExternalCredentialError("key_not_found");
  const actual = hashExternalAgentKey(apiKey);
  const record = await repository.findByHash(actual);
  if (!record || !agentKeyHashMatches(record.keyHash, actual))
    throw new ExternalCredentialError("key_not_found");
  if (record.revokedAt) throw new ExternalCredentialError("key_revoked");
  if (!record.issuerActive) throw new ExternalCredentialError("issuer_left");
  const { agent } = record;
  if (agent.deletedAt || agent.stoppedAt || agent.hosting !== "external")
    throw new ExternalCredentialError("agent_unavailable");
  const at = now();
  const lastUsed = record.lastUsedAt?.getTime();
  if (lastUsed === undefined || at - lastUsed >= EXTERNAL_LAST_USED_INTERVAL_MS) {
    await repository
      .touch(record.id, new Date(at), new Date(at - EXTERNAL_LAST_USED_INTERVAL_MS))
      .catch(() => {});
    void onSeen?.(
      { workspaceId: record.workspaceId, agentId: record.agentId, visibility: agent.visibility },
      at,
    ).catch(() => {});
  }
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
  input: { credentialId: string; agentId: string; workspaceId: string; actorUserId: string },
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
      actorUserId: input.actorUserId,
    });
  return revoked;
}

export function listExternalCredentials(
  repository: Pick<ExternalAgentCredentialRepository, "list">,
  agentId: string,
): Promise<ExternalCredentialSummary[]> {
  return repository.list(agentId);
}
