import { expect, test } from "bun:test";
import { workerKeyId } from "./worker-key-id";

const generated = async () => {
  const { privateKey } = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", privateKey);
};

test("a key always gets the same id, so a restarted Web keeps the one Centrifugo cached", async () => {
  const key = await generated();
  expect(await workerKeyId(key)).toBe(await workerKeyId({ ...key }));
  expect(await workerKeyId(key)).toMatch(/^coforge-e2e-[A-Za-z0-9_-]{16}$/);
});

test("another worktree's key gets another id, so Centrifugo fetches it instead of reusing a cached key", async () => {
  expect(await workerKeyId(await generated())).not.toBe(await workerKeyId(await generated()));
});

test("the id names only the public half: the private scalar does not change it", async () => {
  const key = await generated();
  expect(await workerKeyId({ ...key, d: "something-else" })).toBe(await workerKeyId(key));
});
