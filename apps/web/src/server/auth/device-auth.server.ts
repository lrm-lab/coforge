import { randomBytes, randomInt } from "node:crypto";

import {
  formatUserCode,
  normalizeUserCode,
  USER_CODE_LENGTH,
} from "#src/features/device-auth/device-code-format";
import {
  peekExternalMint,
  type ExternalMintRateLimits,
} from "#src/server/agents/external-agent-mint-rate-limit.server";
import { signComputerAccessToken } from "./computer-access-token.server";
import {
  EXTERNAL_DEVICE_CLIENT_ID,
  readExternalAgentGrant,
  redeemExternalAgentGrant,
  type ExternalAgentDeviceDeps,
  type ExternalAgentDeviceDirectory,
  type ExternalAgentGrant,
  type ExternalAgentRedeemed,
  type ExternalApprovalRefusal,
  type ExternalGrantDetails,
} from "./device-auth-external-agent.server";

/**
 * RFC 8628 device authorization grant - the real one. The E2E double in
 * e2e-device-auth.server.ts stays beside it: the end-to-end harness drives an unattended install
 * with a fixed code, which no real implementation can offer.
 */

/** Deliberately excludes I/L/O/0/1/U - a code is read off one screen and typed into another, so
 * every pair a person confuses is a support ticket. U is dropped so the alphabet cannot spell
 * unfortunate words. 8 characters over 26 symbols is ~38 bits; the alphabet only makes the code
 * transcribable. */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

export const DEVICE_CODE_TTL_SECONDS = 15 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_CLIENT_ID = "coforge-computer";

export type DeviceAuthorizationRecord = {
  id: string;
  userId: string | null;
  status: string;
  expiresAt: Date;
  lastPolledAt: Date | null;
  clientId?: string;
  grant?: unknown;
  approvedAgentId?: string | null;
  approvedWorkspaceId?: string | null;
};

/** The persistence this module needs, kept narrow so the state machine is testable without a
 * database and cannot reach for anything else. */
export interface DeviceAuthorizationStore {
  create(input: {
    deviceCodeHash: string;
    userCodeHash: string;
    expiresAt: Date;
    clientId?: string;
    grant?: ExternalAgentGrant;
  }): Promise<DeviceAuthorizationRecord>;
  findByDeviceCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  findByUserCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  markPolled(id: string, at: Date): Promise<void>;
  /** Each conditional write answers whether it actually transitioned the row, so a caller that
   * lost a race learns it instead of assuming its write landed. `approve`/`deny` also refuse a
   * grant that has expired by `at`. */
  approve(
    id: string,
    userId: string,
    at: Date,
    approval?: { agentId: string; workspaceId: string },
  ): Promise<boolean>;
  deny(id: string, at: Date): Promise<boolean>;
  consume(id: string): Promise<boolean>;
}

/** Both secrets are looked up by digest, never stored in the clear: the device code is a bearer,
 * and the user code is short enough to be typed and therefore short enough to be guessed. SHA-256
 * without a salt is deliberate - lookup is by exact digest, and neither value is user-chosen,
 * low-entropy, or reused anywhere else. */
function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("base64url");
}

function generateUserCode(): string {
  let code = "";
  for (let index = 0; index < USER_CODE_LENGTH; index++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

export type AuthorizeResult = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export async function authorizeDevice(input: {
  store: DeviceAuthorizationStore;
  origin: string;
  now?: () => number;
  clientId?: string;
  grant?: ExternalAgentGrant;
}): Promise<AuthorizeResult> {
  const now = input.now?.() ?? Date.now();
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = generateUserCode();
  await input.store.create({
    deviceCodeHash: digest(deviceCode),
    userCodeHash: digest(userCode),
    expiresAt: new Date(now + DEVICE_CODE_TTL_SECONDS * 1000),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.grant ? { grant: input.grant } : {}),
  });
  // Only the bare page: the person types the code shown on the Computer. A link with the code
  // already in it would let someone send theirs and have it approved by whoever opens it, so none
  // is issued (`verification_uri_complete` is optional in RFC 8628 §3.2), as in Raft 1.0.59.
  return {
    deviceCode,
    userCode: formatUserCode(userCode),
    verificationUri: `${input.origin}/oauth/verify`,
    expiresInSeconds: DEVICE_CODE_TTL_SECONDS,
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

export type PollOutcome =
  | { status: "authorized"; accessToken: string; expiresInSeconds: number }
  | Extract<ExternalAgentRedeemed, { status: "authorized_external_agent" }>
  | {
      status: "error";
      error:
        | "authorization_pending"
        | "slow_down"
        | "expired_token"
        | "access_denied"
        | "invalid_grant";
      coforgeCode?: string;
      retryAfterSeconds?: number;
    };

/**
 * One poll of the token endpoint. The error strings are exactly the ones
 * packages/computer/src/oauth-device-client.ts maps, and an unrecognized string there becomes an
 * opaque client-side failure - so these are a contract, not descriptive text.
 */
export async function pollDeviceToken(input: {
  store: DeviceAuthorizationStore;
  deviceCode: string;
  now?: () => number;
  environment?: Record<string, string | undefined>;
  clientId?: string;
  external?: ExternalAgentDeviceDeps;
}): Promise<PollOutcome> {
  const now = input.now?.() ?? Date.now();
  const record = await input.store.findByDeviceCodeHash(digest(input.deviceCode));
  // An unknown device code and a consumed one are the same answer on purpose: a caller replaying
  // a code it already exchanged learns nothing about whether it once existed.
  if (!record || record.status === "consumed") return { status: "error", error: "invalid_grant" };
  const clientId = input.clientId ?? DEVICE_CLIENT_ID;
  if ((record.clientId ?? DEVICE_CLIENT_ID) !== clientId)
    return { status: "error", error: "invalid_grant" };
  if (record.expiresAt.getTime() <= now) return { status: "error", error: "expired_token" };
  if (record.status === "denied") return { status: "error", error: "access_denied" };

  // Polling faster than the advertised interval earns `slow_down` rather than an answer. Checked
  // before the pending branch so an impatient client is told to back off even while it waits.
  const lastPolled = record.lastPolledAt?.getTime();
  const tooSoon =
    lastPolled !== undefined && now - lastPolled < DEVICE_POLL_INTERVAL_SECONDS * 1000;
  await input.store.markPolled(record.id, new Date(now));
  if (tooSoon) return { status: "error", error: "slow_down" };

  if (record.status !== "approved" || !record.userId)
    return { status: "error", error: "authorization_pending" };

  // Consume before minting: a device code is single-use. The conditional write is what enforces
  // it - two polls can both read `approved`, and only the one whose consume actually transitions
  // the row may be handed a token. The loser sees the same answer a replayed code gets.
  if (clientId === EXTERNAL_DEVICE_CLIENT_ID) {
    if (!input.external) return { status: "error", error: "invalid_grant" };
    const { approvedAgentId: agentId, approvedWorkspaceId: workspaceId } = record;
    if (!agentId || !workspaceId) return { status: "error", error: "invalid_grant" };
    const refusal = await input.external.directory.approvalRefusal({
      userId: record.userId,
      workspaceId,
      agentId,
    });
    if (refusal) {
      await input.store.consume(record.id);
      return { status: "error", error: "access_denied", coforgeCode: refusal };
    }
  }
  const consumed = await input.store.consume(record.id);
  if (!consumed) return { status: "error", error: "invalid_grant" };
  if (clientId === EXTERNAL_DEVICE_CLIENT_ID)
    return redeemExternalAgentGrant(input.external!, record);
  const { token, expiresInSeconds } = await signComputerAccessToken(
    record.userId,
    input.environment,
  );
  return { status: "authorized", accessToken: token, expiresInSeconds };
}

export type UserCodeLookup =
  | { found: true; id: string; expiresAt: Date; external?: ExternalGrantDetails }
  | {
      found: false;
      reason: "unknown" | "expired" | "settled" | ExternalApprovalRefusal;
    };

/** Resolves a typed code for the approval page, without disclosing more than whether it is
 * actionable. A coforge-cli code carries only the machine that asked: the person picks the Agent
 * on approval, so nothing here names one. */
export async function lookupUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  now?: () => number;
  userId?: string;
  mintLimits?: ExternalMintRateLimits;
}): Promise<UserCodeLookup> {
  const now = input.now?.() ?? Date.now();
  const normalized = normalizeUserCode(input.userCode);
  if (normalized.length !== USER_CODE_LENGTH) return { found: false, reason: "unknown" };
  const record = await input.store.findByUserCodeHash(digest(normalized));
  if (!record) return { found: false, reason: "unknown" };
  if (record.expiresAt.getTime() <= now) return { found: false, reason: "expired" };
  if (record.status !== "pending") return { found: false, reason: "settled" };
  if (record.clientId === EXTERNAL_DEVICE_CLIENT_ID) {
    const external = readExternalAgentGrant(record.grant);
    if (!input.userId || !external) return { found: false, reason: "unknown" };
    if (
      input.mintLimits &&
      !(await peekExternalMint(input.mintLimits, { userId: input.userId })).allowed
    )
      return { found: false, reason: "mint_rate_limited" };
    return { found: true, id: record.id, expiresAt: record.expiresAt, external };
  }
  return { found: true, id: record.id, expiresAt: record.expiresAt };
}

async function externalApprovalRefusal(input: {
  directory: Pick<ExternalAgentDeviceDirectory, "target" | "approvalRefusal">;
  mintLimits?: ExternalMintRateLimits | undefined;
  userId: string;
  agentId: string | undefined;
}): Promise<
  { refusal: ExternalApprovalRefusal } | { target: { agentId: string; workspaceId: string } }
> {
  if (!input.agentId) return { refusal: "agent_not_found" };
  const target = await input.directory.target(input.agentId);
  if (!target) return { refusal: "agent_not_found" };
  if (target.hosting !== "external") return { refusal: "agent_not_external" };
  const refusal = await input.directory.approvalRefusal({
    userId: input.userId,
    workspaceId: target.workspaceId,
    agentId: input.agentId,
  });
  if (refusal) return { refusal };
  if (
    input.mintLimits &&
    !(await peekExternalMint(input.mintLimits, { userId: input.userId, agentId: input.agentId }))
      .allowed
  )
    return { refusal: "mint_rate_limited" };
  return { target: { agentId: input.agentId, workspaceId: target.workspaceId } };
}

export async function approveUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  userId: string;
  now?: () => number;
  agentId?: string | undefined;
  directory?: Pick<ExternalAgentDeviceDirectory, "target" | "approvalRefusal">;
  mintLimits?: ExternalMintRateLimits | undefined;
}): Promise<UserCodeLookup> {
  const lookup = await lookupUserCode(input);
  if (!lookup.found) return lookup;
  const at = new Date(input.now?.() ?? Date.now());
  let target: { agentId: string; workspaceId: string } | undefined;
  if (lookup.external) {
    if (!input.directory) return { found: false, reason: "unknown" };
    const checked = await externalApprovalRefusal({
      directory: input.directory,
      mintLimits: input.mintLimits,
      userId: input.userId,
      agentId: input.agentId,
    });
    if ("refusal" in checked) return { found: false, reason: checked.refusal };
    target = checked.target;
  }
  const approved = await input.store.approve(lookup.id, input.userId, at, target);
  if (!approved) return lookupUserCode(input);
  return lookup;
}

export async function denyUserCode(input: {
  store: DeviceAuthorizationStore;
  userCode: string;
  now?: () => number;
  userId?: string;
}): Promise<UserCodeLookup> {
  const lookup = await lookupUserCode(input);
  if (!lookup.found) return lookup;
  const at = new Date(input.now?.() ?? Date.now());
  const denied = await input.store.deny(lookup.id, at);
  if (!denied) return lookupUserCode(input);
  return lookup;
}
