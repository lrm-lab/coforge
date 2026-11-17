import { utf8Decoder, utf8Encoder } from "@lrm/coforge-sdk/internal";

export class InvalidSealedValueError extends Error {
  constructor() {
    super("invalid sealed value");
    this.name = "InvalidSealedValueError";
  }
}

export class SealedValues {
  private readonly key: Promise<CryptoKey>;

  constructor(rawKey: Uint8Array<ArrayBuffer>) {
    this.key = crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async seal(context: string, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8Encoder.encode(context) },
      await this.key,
      utf8Encoder.encode(value),
    );
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
  }

  async open(context: string, sealed: string): Promise<string> {
    const [version, iv, ciphertext, extra] = sealed.split(".");
    if (version !== "v1" || !iv || !ciphertext || extra) throw new InvalidSealedValueError();
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(iv, "base64url"),
        additionalData: utf8Encoder.encode(context),
      },
      await this.key,
      Buffer.from(ciphertext, "base64url"),
    );
    return utf8Decoder.decode(plain);
  }
}
