import { AppError } from "#src/lib/app-error";

import { utf8Encoder, utf8Decoder } from "@lrm/coforge-sdk/internal";

/** AES-GCM sealing of GitHub secrets, bound to the client, the user, and the purpose. */
export class GitHubSealedValues {
  constructor(
    private readonly config: { clientId: string; encryptionKey: Uint8Array<ArrayBuffer> },
  ) {}

  async seal(userId: string, purpose: string, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8Encoder.encode(`${this.config.clientId}:${userId}:${purpose}`),
      },
      await this.key(),
      utf8Encoder.encode(value),
    );
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
  }

  async open(userId: string, purpose: string, value: string) {
    const [version, nonce, ciphertext, extra] = value.split(".");
    if (version !== "v1" || !nonce || !ciphertext || extra)
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(nonce, "base64url"),
        additionalData: utf8Encoder.encode(`${this.config.clientId}:${userId}:${purpose}`),
      },
      await this.key(),
      Buffer.from(ciphertext, "base64url"),
    );
    return utf8Decoder.decode(plaintext);
  }

  private key() {
    return crypto.subtle.importKey("raw", this.config.encryptionKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
}
