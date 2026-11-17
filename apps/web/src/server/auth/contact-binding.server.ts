import { randomBytes } from "node:crypto";
import type { RedisClient } from "bun";
import { codeDestinationKey, type CodeDestination } from "#src/features/auth/code-destination";
import type { PrismaClient } from "#src/generated/prisma/client";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import {
  CodeSendRefusedError,
  CodeSendThrottledError,
  ContactBindRefusedError,
  createAuthingAuthentication,
  type AuthingAuthentication,
  type AuthingConfig,
} from "./authing-authentication.server";
import { clearCookie, extractProfileContacts, serializeCookie } from "./browser-login.server";
import {
  atSignInStage,
  reportCodeSendRateLimited,
  reportCodeSendThrottled,
  reportSignInFailure,
  reportTokenRevocationFailure,
} from "./login-failure.server";
import { admitCodeSend, type CodeSendRateLimits } from "./sign-in-rate-limits.server";
import { UserIdentityRepository } from "./user-identity.repository.server";

/** How long a staged GitHub elevation token stays valid in Redis for contact binding. */
export const CONTACT_BIND_TTL_SECONDS = 10 * 60;
export const CONTACT_BIND_COOKIE = "coforge_contact_bind";

export function contactBindCookie(bindToken: string, secure: boolean): string {
  return serializeCookie(CONTACT_BIND_COOKIE, bindToken, CONTACT_BIND_TTL_SECONDS, secure);
}

export function contactBindEndingCookie(secure: boolean): string {
  return clearCookie(CONTACT_BIND_COOKIE, secure);
}

const CONSUME_SCRIPT =
  'local v = redis.call("GET", KEYS[1]); if v then redis.call("DEL", KEYS[1]); end; return v';

export type StagedContactBind = {
  userId: string;
  authingSub: string;
  accessToken: string;
};

export interface ContactBindStore {
  put(record: StagedContactBind, ttlSeconds?: number): Promise<string>;
  peek(tokenId: string): Promise<StagedContactBind | null>;
  consume(tokenId: string): Promise<StagedContactBind | null>;
}

function contactBindKey(tokenId: string): string {
  return `coforge:auth:contact-bind:${encodeURIComponent(tokenId)}`;
}

function parseStagedContactBind(raw: unknown): StagedContactBind | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StagedContactBind>;
    if (
      typeof parsed.userId === "string" &&
      parsed.userId &&
      typeof parsed.authingSub === "string" &&
      parsed.authingSub &&
      typeof parsed.accessToken === "string" &&
      parsed.accessToken
    ) {
      return {
        userId: parsed.userId,
        authingSub: parsed.authingSub,
        accessToken: parsed.accessToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class RedisContactBindStore implements ContactBindStore {
  constructor(private readonly redis: Pick<RedisClient, "get" | "send">) {}

  async put(record: StagedContactBind, ttlSeconds = CONTACT_BIND_TTL_SECONDS): Promise<string> {
    const tokenId = randomBytes(32).toString("base64url");
    await this.redis.send("SET", [
      contactBindKey(tokenId),
      JSON.stringify(record),
      "EX",
      String(ttlSeconds),
    ]);
    return tokenId;
  }

  async peek(tokenId: string): Promise<StagedContactBind | null> {
    return parseStagedContactBind(await this.redis.get(contactBindKey(tokenId)));
  }

  async consume(tokenId: string): Promise<StagedContactBind | null> {
    const raw = await this.redis.send("EVAL", [CONSUME_SCRIPT, "1", contactBindKey(tokenId)]);
    return parseStagedContactBind(raw);
  }
}

export class MemoryContactBindStore implements ContactBindStore {
  private readonly entries = new Map<string, { record: StagedContactBind; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(record: StagedContactBind, ttlSeconds = CONTACT_BIND_TTL_SECONDS): Promise<string> {
    const tokenId = randomBytes(32).toString("base64url");
    this.entries.set(tokenId, { record, expiresAt: this.now() + ttlSeconds * 1000 });
    return tokenId;
  }

  async peek(tokenId: string): Promise<StagedContactBind | null> {
    const entry = this.entries.get(tokenId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(tokenId);
      return null;
    }
    return entry.record;
  }

  async consume(tokenId: string): Promise<StagedContactBind | null> {
    const record = await this.peek(tokenId);
    this.entries.delete(tokenId);
    return record;
  }
}

let singleton: ContactBindStore | undefined;

export function contactBindStore(): ContactBindStore | undefined {
  if (!Bun.env.REDIS_URL) return undefined;
  return (singleton ??= new RedisContactBindStore(openRedisClient(redisUrlFor("contact binding"))));
}

function revokeInBackground(authing: AuthingAuthentication, token: string): void {
  void (async () => authing.revokeToken(token))().catch(reportTokenRevocationFailure);
}

async function revokeNow(authing: AuthingAuthentication, token: string): Promise<void> {
  try {
    await authing.revokeToken(token);
  } catch (error) {
    reportTokenRevocationFailure(error);
  }
}

export type StageGitHubContactBindResult =
  | { status: "staged"; bindToken: string }
  | { status: "identity_mismatch" }
  | { status: "failed" };

/**
 * Exchanges a GitHub OAuth callback code for an Authing user token without creating a login
 * session, verifies the returned `authingSub` belongs to `userId`, and stages the token in Redis
 * for 10 minutes so the signed-in user can send a bind code and bind a phone or email.
 */
export async function stageGitHubContactBind(input: {
  db: PrismaClient;
  store: ContactBindStore;
  userId: string;
  code: string;
  connection: string;
  authingConfig: AuthingConfig;
  authing?: AuthingAuthentication;
}): Promise<StageGitHubContactBindResult> {
  const authing = input.authing ?? createAuthingAuthentication(input.authingConfig);
  let accessToken: string | undefined;
  let staged = false;
  try {
    const tokens = await atSignInStage("github_sign_in", () =>
      authing.signInWithGitHubCode({ code: input.code, connection: input.connection }),
    );
    accessToken = tokens.accessToken;
    const profile = await atSignInStage("userinfo", () =>
      authing.fetchUserInfo(tokens.accessToken),
    );
    const identity = await atSignInStage("user_resolution", () =>
      input.db.userIdentity.findUnique({
        where: {
          provider_providerSubject: { provider: "authing", providerSubject: profile.sub },
        },
        select: { userId: true },
      }),
    );
    if (!identity || identity.userId !== input.userId) {
      return { status: "identity_mismatch" };
    }
    const bindToken = await input.store.put({
      userId: input.userId,
      authingSub: profile.sub,
      accessToken: tokens.accessToken,
    });
    staged = true;
    return { status: "staged", bindToken };
  } catch (error) {
    reportSignInFailure(error);
    return { status: "failed" };
  } finally {
    if (accessToken && !staged) revokeInBackground(authing, accessToken);
  }
}

export type SendContactBindCodeResult =
  | { status: "sent" }
  | { status: "invalid_bind_token" }
  | { status: "rate_limited" }
  | { status: "refused" }
  | { status: "send_failed" };

/**
 * Sends a verification code (`CHANNEL_BIND_PHONE` / `CHANNEL_BIND_EMAIL`) using the staged
 * GitHub elevation token, after verifying the token belongs to the signed-in `userId`.
 */
export async function sendContactBindCode(input: {
  store: ContactBindStore;
  userId: string;
  bindToken: string;
  destination: CodeDestination;
  config: AuthingConfig;
  rateLimits: CodeSendRateLimits;
  clientAddress?: string | undefined;
  authing?: AuthingAuthentication;
}): Promise<SendContactBindCodeResult> {
  const staged = await input.store.peek(input.bindToken);
  if (!staged || staged.userId !== input.userId) {
    return { status: "invalid_bind_token" };
  }
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  try {
    const admission = await admitCodeSend(input.rateLimits, {
      destination: codeDestinationKey(input.destination),
      clientAddress: input.clientAddress,
    });
    if (!admission.allowed) {
      reportCodeSendRateLimited(admission.limit);
      return { status: "rate_limited" };
    }
    await authing.sendBindCode({ token: staged.accessToken, destination: input.destination });
    return { status: "sent" };
  } catch (error) {
    if (error instanceof CodeSendThrottledError) {
      reportCodeSendThrottled();
      return { status: "rate_limited" };
    }
    if (error instanceof CodeSendRefusedError) {
      return { status: "refused" };
    }
    reportSignInFailure(error);
    return { status: "send_failed" };
  }
}

export type BindAccountContactResult =
  | { status: "bound"; email: string | null; phone: string | null }
  | { status: "invalid_bind_token" }
  | { status: "refused" }
  | { status: "failed" };

/**
 * Consumes the one-time staged token, binds the verified phone or email in Authing, syncs the
 * updated profile contacts back to `User`, and immediately revokes the Authing user token.
 */
export async function bindAccountContact(input: {
  db: PrismaClient;
  store: ContactBindStore;
  userId: string;
  bindToken: string;
  destination: CodeDestination;
  passCode: string;
  config: AuthingConfig;
  authing?: AuthingAuthentication;
}): Promise<BindAccountContactResult> {
  const staged = await input.store.consume(input.bindToken);
  if (!staged) return { status: "invalid_bind_token" };
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  try {
    if (staged.userId !== input.userId) {
      return { status: "invalid_bind_token" };
    }
    await authing.bindContact({
      token: staged.accessToken,
      destination: input.destination,
      passCode: input.passCode,
    });
    const profile = await atSignInStage("userinfo", () =>
      authing.fetchUserInfo(staged.accessToken),
    );
    const contacts = extractProfileContacts(profile);
    const updated = await new UserIdentityRepository(input.db).syncContacts(input.userId, contacts);
    return { status: "bound", email: updated.email, phone: updated.phone };
  } catch (error) {
    if (error instanceof ContactBindRefusedError) {
      return { status: "refused" };
    }
    reportSignInFailure(error);
    return { status: "failed" };
  } finally {
    await revokeNow(authing, staged.accessToken);
  }
}
