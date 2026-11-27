import { expect, test } from "bun:test";
import { verifyAttachSignature } from "#src/internal/computer-attach-signature";
import wycheproof from "./fixtures/wycheproof-ed25519.json";

const decodeHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

test.each(wycheproof.vectors)(
  "applies the attach acceptance policy to Wycheproof case $id",
  async (vector) => {
    expect(
      await verifyAttachSignature(
        decodeHex(vector.publicKey),
        decodeHex(vector.message),
        decodeHex(vector.signature),
      ),
    ).toBe(vector.accepted);
  },
);
