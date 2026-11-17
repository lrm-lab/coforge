import { pushWebhookSealer, type PushWebhookSealer } from "#src/server/sealed-values.server";
import { readOptionalAgentRuntimeCredentialEncryptionKey } from "./agent-runtime-credentials.server";

export { pushWebhookSealer, type PushWebhookSealer };

let memoized: Promise<PushWebhookSealer | undefined> | undefined;

export function productionPushWebhookSealer(): Promise<PushWebhookSealer | undefined> {
  memoized ??= readOptionalAgentRuntimeCredentialEncryptionKey(process.env).then(
    (key) => (key ? pushWebhookSealer(key) : undefined),
    (error: unknown) => {
      memoized = undefined;
      throw error;
    },
  );
  return memoized;
}

const HEX = /^[0-9a-fA-F]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const PUSH_SECRET_MAX_LENGTH = 512;

export function isStrongPushSecret(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PUSH_SECRET_MAX_LENGTH) return false;
  if (HEX.test(value)) return value.length >= 64;
  return BASE64URL.test(value) && value.length >= 43;
}
