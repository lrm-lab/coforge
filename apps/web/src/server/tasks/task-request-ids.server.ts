import { utf8Encoder } from "@lrm/coforge-sdk/internal";

export async function indexedRequestId(requestId: string, index: number) {
  if (index === 0) return requestId;
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", utf8Encoder.encode(`${requestId}:${index}`)),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
