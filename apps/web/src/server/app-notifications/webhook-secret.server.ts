import { createHmac } from "node:crypto";
import { readEnvSecret } from "#src/server/files/env-secret.server";
import type { WebhookRow } from "./app-webhook-store";

/** The key a webhook secret is derived from is unusable, which fails the boot. Messages name the
 * variable and what is wrong, never the value. */
export class AppWebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppWebhookConfigError";
  }
}

export type AppWebhookConfiguration = { status: "disabled" } | { status: "ready"; key: string };

/** The shortest key: 32 bytes of entropy written as 64 hexadecimal characters is the convention
 * of `COFORGE_AGENT_RUNTIME_CREDENTIAL_KEY`, and the key is not parsed, only measured. */
export const APP_WEBHOOK_KEY_MIN_LENGTH = 32;

/** Unset (or blank) leaves webhooks off on this deployment: none can be enabled and none is
 * delivered. A set key shorter than `APP_WEBHOOK_KEY_MIN_LENGTH` fails the boot. */
export async function readAppWebhookConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<AppWebhookConfiguration> {
  const key = await readEnvSecret(environment, "COFORGE_APP_WEBHOOK_KEY", (message) => {
    throw new AppWebhookConfigError(message);
  });
  if (!key) return { status: "disabled" };
  if (key.length < APP_WEBHOOK_KEY_MIN_LENGTH) {
    throw new AppWebhookConfigError(
      `COFORGE_APP_WEBHOOK_KEY must be at least ${APP_WEBHOOK_KEY_MIN_LENGTH} characters`,
    );
  }
  return { status: "ready", key };
}

let remembered: string | undefined;

/** Publishes the key the boot read (`assertStartupConfig`), so requests never read it. */
export function rememberAppWebhookKey(key: string | undefined): void {
  remembered = key;
}

export function forgetAppWebhookKey(): void {
  remembered = undefined;
}

/** The key the boot remembered; none before it has, or when the deployment has none. */
export function webhookKey(): string | undefined {
  return remembered;
}

/** Keeps a derived secret from ever being another use of the same key. */
const DERIVATION_CONTEXT = "coforge-app-webhook-v1";

/**
 * The signing secret of an app at a generation, in the Standard Webhooks form: `whsec_` and the
 * base64 of HMAC-SHA256(key, `coforge-app-webhook-v1:<appId>:<generation>`), 32 bytes. The label
 * separates this use of the key from any other. It is derived, never stored, so a database read
 * cannot reveal it; rotation is the generation going up by one.
 */
export function deriveWebhookSecret(key: string, appId: string, generation: number): string {
  // `node:crypto`, not `Bun.CryptoHasher`: Bun 1.4.4's HMAC constructor throws an error a failed Web
  // Crypto key import left on the thread's OpenSSL queue (`test/app-webhook-signing`).
  const digest = createHmac("sha256", key)
    .update(`${DERIVATION_CONTEXT}:${appId}:${generation}`)
    .digest("base64");
  return `whsec_${digest}`;
}

type SecretGenerations = Pick<
  WebhookRow,
  "secretGeneration" | "previousSecretGeneration" | "previousSecretValidUntil"
>;

/** Until when the previous secret still signs, or `null` when no rotation overlaps at `at`. */
export function previousSecretValidUntil(row: SecretGenerations, at: Date): Date | null {
  const until = row.previousSecretValidUntil;
  return row.previousSecretGeneration !== null && until !== null && until > at ? until : null;
}

/** The secrets that sign a delivery at `at`: the current one first, then the previous one while a
 * rotation overlaps. */
export function signingSecrets(
  key: string,
  appId: string,
  row: SecretGenerations,
  at: Date,
): string[] {
  const secrets = [deriveWebhookSecret(key, appId, row.secretGeneration)];
  const previous = row.previousSecretGeneration;
  if (previous !== null && previousSecretValidUntil(row, at) !== null) {
    secrets.push(deriveWebhookSecret(key, appId, previous));
  }
  return secrets;
}
