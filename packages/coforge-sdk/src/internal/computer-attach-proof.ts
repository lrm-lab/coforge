import { keygenAsync, signAsync } from "@noble/ed25519";
import { verifyAttachSignature } from "./computer-attach-signature";
import { utf8Encoder } from "./text-codec";

const SIGNING_DOMAIN = "coforge-computer-attach:v1";

export type AttachProofChallenge = {
  origin: string;
  sessionId: string;
  purpose: "complete" | "resume";
  nonce: string;
};

export function attachProofBytes(challenge: AttachProofChallenge): Uint8Array<ArrayBuffer> {
  const url = new URL(challenge.origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("Computer attach requires an HTTP(S) origin without credentials");
  return utf8Encoder.encode(
    JSON.stringify([
      SIGNING_DOMAIN,
      url.origin,
      challenge.sessionId,
      challenge.purpose,
      challenge.nonce,
    ]),
  );
}

export async function attachPublicKeyFingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(publicKey));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyAttachProof(
  publicKey: Uint8Array,
  challenge: AttachProofChallenge,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await verifyAttachSignature(publicKey, attachProofBytes(challenge), signature);
  } catch {
    return false;
  }
}

export const createAttachKeyPair = keygenAsync;

export function signAttachProof(privateKey: Uint8Array, challenge: AttachProofChallenge) {
  return signAsync(attachProofBytes(challenge), privateKey);
}
