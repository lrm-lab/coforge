import { utf8Decoder, utf8Encoder } from "@lrm/coforge-sdk/internal";
import { readOptionalAgentRuntimeCredentialEncryptionKey } from "./agent-runtime-credentials.server";

export type PushWebhookSealer = {
  seal(agentId: string, secret: string): Promise<string>;
  open(agentId: string, sealed: string): Promise<string>;
};

const associatedData = (agentId: string) =>
  utf8Encoder.encode(`external-push-webhook:v1:${agentId}`);

export function pushWebhookSealer(rawKey: Uint8Array<ArrayBuffer>): PushWebhookSealer {
  const key = crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async seal(agentId, secret) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: associatedData(agentId) },
        await key,
        utf8Encoder.encode(secret),
      );
      return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(sealed).toString("base64url")}`;
    },
    async open(agentId, sealed) {
      const [version, iv, ciphertext, extra] = sealed.split(".");
      if (version !== "v1" || !iv || !ciphertext || extra) throw new Error("invalid sealed secret");
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(iv, "base64url"),
          additionalData: associatedData(agentId),
        },
        await key,
        Buffer.from(ciphertext, "base64url"),
      );
      return utf8Decoder.decode(plain);
    },
  };
}

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
