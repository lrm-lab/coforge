import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { readEnvSecret } from "#src/server/files/env-secret.server";
import { UserIdentityRepository } from "./user-identity.repository.server";

const WEBHOOK_SECRET_HEADER = "x-authing-webhook-secret";

/**
 * `COFORGE_AUTHING_WEBHOOK_SECRET` (or `_FILE`), the shared secret Authing sends as
 * `x-authing-webhook-secret` on every webhook post. Unset leaves the endpoint answering 503;
 * both forms set, or an unreadable file, is an operator problem (`TEMPORARILY_UNAVAILABLE`).
 */
export async function readAuthingWebhookSecret(
  env: NodeJS.ProcessEnv = Bun.env,
): Promise<string | null> {
  const secret = await readEnvSecret(env, "COFORGE_AUTHING_WEBHOOK_SECRET", () => {
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  });
  return secret ?? null;
}

/** The header against the configured secret, compared in constant time. */
export function verifyAuthingWebhookSecret(secret: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(secret, "utf8");
  const provided = Buffer.from(header, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

const webhookEventSchema = z.object({ eventName: z.string(), data: z.unknown() });

/**
 * The Authing user id a `user:*` event carries, read tolerantly across the payload shapes Authing
 * has been seen to send (`data.userId`, `data.user.userId`, `data.user.id`, `data.id`); `undefined`
 * when none is positively identified, so a guessed field never marks an account verified.
 */
function authingUserId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const user =
    typeof record.user === "object" && record.user !== null
      ? (record.user as Record<string, unknown>)
      : undefined;
  for (const candidate of [record.userId, user?.userId, user?.id, record.id]) {
    if (typeof candidate === "string" && candidate) return candidate;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
      return String(candidate);
    }
  }
  return undefined;
}

/**
 * Applies one already secret-verified Authing webhook event. Tolerant of unrecognized events and
 * malformed payloads: both are silent no-ops so the route can always answer 200 (Authing retries
 * non-2xx responses, and a payload we cannot understand will not become understandable on retry).
 * Never logs payloads: they carry user data.
 */
export async function applyAuthingWebhookEvent(
  db: PrismaClient,
  payload: unknown,
  identities: Pick<UserIdentityRepository, "markEmailVerified"> = new UserIdentityRepository(db),
): Promise<void> {
  const parsed = webhookEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.eventName !== "user:email-verified") return;
  const userId = authingUserId(parsed.data.data);
  if (!userId) return;
  await identities.markEmailVerified("authing", userId);
}

/**
 * `POST /api/authing/webhook`. The secret header is checked before the body is even read; a
 * missing or wrong one is a 401, an unconfigured deployment a 503. Everything else — handled,
 * irrelevant and malformed events alike — answers 200 so Authing never retries what it should
 * not, while a failure to write (the database is down) still answers 5xx and is retried.
 */
export async function authingWebhookHandler({ request }: { request: Request }) {
  const headers = new Headers({ "cache-control": "no-store" });
  // A misconfigured secret file is an operator problem, not a crash: 503 shows it plainly.
  const secret = await readAuthingWebhookSecret().catch(() => null);
  if (!secret) return new Response(null, { status: 503, headers });
  if (!verifyAuthingWebhookSecret(secret, request.headers.get(WEBHOOK_SECRET_HEADER))) {
    return new Response(null, { status: 401, headers });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 200, headers });
  }
  await applyAuthingWebhookEvent(requireDatabaseClient(), payload);
  return new Response(null, { status: 200, headers });
}
