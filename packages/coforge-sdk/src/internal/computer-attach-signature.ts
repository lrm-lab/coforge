import { Point, verifyAsync } from "@noble/ed25519";

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function isNonIdentityPrimeOrderPoint(bytes: Uint8Array): boolean {
  const point = Point.fromBytes(bytes, false);
  return !point.is0() && point.isTorsionFree();
}

export async function verifyAttachSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    return (
      isNonIdentityPrimeOrderPoint(publicKey) &&
      isNonIdentityPrimeOrderPoint(signature.subarray(0, PUBLIC_KEY_BYTES)) &&
      (await verifyAsync(signature, message, publicKey, { zip215: false }))
    );
  } catch {
    return false;
  }
}
