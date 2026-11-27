import { describe, expect, test } from "bun:test";
import {
  attachProofBytes,
  attachPublicKeyFingerprint,
  verifyAttachProof,
  type AttachProofChallenge,
} from "./computer-attach-proof";

const challenge: AttachProofChallenge = {
  origin: "https://coforge.example",
  sessionId: "12345678-1234-4234-9234-123456789abc",
  purpose: "complete",
  nonce: "sample-server-nonce",
};

describe("Computer attach proofs", () => {
  test("encodes one versioned, unambiguous signing transcript", () => {
    expect(new TextDecoder().decode(attachProofBytes(challenge))).toBe(
      '["coforge-computer-attach:v1","https://coforge.example","12345678-1234-4234-9234-123456789abc","complete","sample-server-nonce"]',
    );
  });

  test("uses the HTTP origin with a lowercased host and without the default port", () => {
    expect(attachProofBytes({ ...challenge, origin: "HTTPS://COFORGE.Example:443/" })).toEqual(
      attachProofBytes(challenge),
    );
    expect(attachProofBytes({ ...challenge, origin: "https://coforge.example:444/" })).not.toEqual(
      attachProofBytes(challenge),
    );
    expect(() =>
      attachProofBytes({ ...challenge, origin: "https://user@coforge.example" }),
    ).toThrow();
    expect(() => attachProofBytes({ ...challenge, origin: "file:///tmp" })).toThrow();
  });

  test("an Ed25519 signature is valid only for its key and exact challenge", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const otherPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    if (!("publicKey" in pair) || !("publicKey" in otherPair))
      throw new TypeError("Ed25519 generation did not return a key pair");
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const wrongKey = new Uint8Array(await crypto.subtle.exportKey("raw", otherPair.publicKey));
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", pair.privateKey, attachProofBytes(challenge)),
    );

    expect(await verifyAttachProof(publicKey, challenge, signature)).toBe(true);
    expect(await verifyAttachProof(wrongKey, challenge, signature)).toBe(false);
    expect(await verifyAttachProof(publicKey, challenge, signature.subarray(1))).toBe(false);
    for (const modified of [
      { ...challenge, origin: "https://other.example" },
      { ...challenge, sessionId: "12345678-1234-4234-9234-123456789abd" },
      { ...challenge, purpose: "resume" as const },
      { ...challenge, nonce: "a-new-challenge" },
    ]) {
      expect(await verifyAttachProof(publicKey, modified, signature)).toBe(false);
    }
  });

  test("shows the same eight-byte fingerprint for the same public key", async () => {
    const publicKey = Uint8Array.from(
      Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"),
    );
    expect(await attachPublicKeyFingerprint(publicKey)).toBe("21fe31dfa154a261");
  });
});
