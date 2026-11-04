import { timingSafeEqual } from "node:crypto";
import { type JWK } from "jose";

import { mintOpaqueToken, sha256Hex } from "./opaque-token.server";

export type DaemonApiKeyClaims = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly computerId: string;
  /** `daemon` is the legacy `daemonApiKey`; `computer` the `sk_computer` a swap-key issued. */
  readonly kind: "daemon" | "computer";
  /** The verified key's hash — `confirm-key` revokes the other unconfirmed `sk_computer`s,
   * never the one that asked. */
  readonly apiKeyHash: string;
};

export type DaemonApiKeyRecord = {
  id: string;
  apiKeyHash: string;
  workspaceId: string;
  computerId: string;
  ownerId: string;
  revokedAt: Date | null;
  lastUsedAt?: Date | null;
  /** Whether the key's owner is still a member of the key's Workspace, read with the key. */
  ownerIsMember: boolean;
  /// `daemon` is the legacy `daemonApiKey`; `computer` the `sk_computer` a swap-key issued.
  kind: "daemon" | "computer";
};

/** What minting supplies for `replaceActive`: the Prisma client generates the id
 * from the schema default (`uuid(7)`), keeping one id-generation path for the project. */
export type DaemonApiKeyMint = Omit<DaemonApiKeyRecord, "id" | "ownerIsMember">;

export interface DaemonApiKeyRepository {
  replaceActive(record: DaemonApiKeyMint): Promise<void>;
  findByHash(hash: string): Promise<DaemonApiKeyRecord | undefined>;
  markUsed(id: string, at: Date): Promise<void>;
}

const DAEMON_API_KEY = /^(dk|sk_computer)_[A-Za-z0-9_-]{43}$/;
/** Every daemon RPC and Agent HTTP call verifies the key, so its last use is a coarse
 * timestamp: writing it per request would serialize one Computer's traffic on its key row. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** Whether `value` has the shape of a daemon API key this server mints. */
export function isDaemonApiKey(value: string): boolean {
  return DAEMON_API_KEY.test(value);
}

export function hashDaemonApiKey(value: string): string {
  return sha256Hex(value);
}

export function createDaemonApiKeyFactory(repository: DaemonApiKeyRepository) {
  return {
    async create(input: {
      principal: { userId: string };
      workspaceId: string;
      computerId: string;
      kind?: "daemon" | "computer";
    }) {
      const { apiKey, record } = prepareDaemonApiKey(input);
      await repository.replaceActive(record);
      return apiKey;
    },
  };
}

export function prepareDaemonApiKey({
  principal,
  workspaceId,
  computerId,
  kind = "daemon",
}: {
  principal: { userId: string };
  workspaceId: string;
  computerId: string;
  /// `daemon` is the legacy `daemonApiKey`; `computer` the `sk_computer` a swap-key issued.
  kind?: "daemon" | "computer";
}) {
  const apiKey =
    kind === "computer" ? `sk_computer_${mintOpaqueToken()}` : `dk_${mintOpaqueToken()}`;
  // No explicit id: the Prisma client generates it from the schema's uuid(7)
  // default — API keys keep the project's one id-generation path end to end.
  return {
    apiKey,
    record: {
      apiKeyHash: hashDaemonApiKey(apiKey),
      workspaceId,
      computerId,
      ownerId: principal.userId,
      revokedAt: null,
      kind,
    } satisfies DaemonApiKeyMint,
  };
}

/**
 * A live key whose owner is no longer a member of its Workspace. The message is the ordinary one;
 * the type lets the connect proxy refuse the holder of that exact key for good.
 */
export class DaemonApiKeyOwnerNotMemberError extends Error {
  constructor(readonly claims: DaemonApiKeyClaims) {
    super("invalid Daemon API key");
    this.name = "DaemonApiKeyOwnerNotMemberError";
  }
}

/** The key's claims while it is live and its owner is still a member of its Workspace. */
export async function verifyDaemonApiKey(
  apiKey: string,
  repository: DaemonApiKeyRepository,
  now: Date = new Date(),
): Promise<DaemonApiKeyClaims> {
  if (!isDaemonApiKey(apiKey)) throw new Error("invalid Daemon API key");
  const actual = Buffer.from(hashDaemonApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record || record.revokedAt) throw new Error("invalid Daemon API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Daemon API key");
  const claims = {
    userId: record.ownerId,
    workspaceId: record.workspaceId,
    computerId: record.computerId,
    kind: record.kind,
    apiKeyHash: record.apiKeyHash,
  };
  if (!record.ownerIsMember) throw new DaemonApiKeyOwnerNotMemberError(claims);
  if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS)
    await repository.markUsed(record.id, now);
  return claims;
}

/** User-authorized Computer registration still uses the existing JWT issuer. */
export async function computerRegistrationJwks(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ keys: JWK[] }> {
  const value = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  if (!value) throw new Error("Computer registration JWT is not configured");
  const privateJwk = JSON.parse(value) as JWK;
  const { d: _privateKey, key_ops: _keyOps, ...publicJwk } = privateJwk;
  return {
    keys: [
      {
        ...publicJwk,
        kid: environment.COFORGE_WORKER_JWT_KEY_ID,
        alg: "EdDSA",
        use: "sig",
        key_ops: ["verify"],
      },
    ],
  };
}
