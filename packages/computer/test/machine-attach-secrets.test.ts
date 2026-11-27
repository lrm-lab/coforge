import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signAttachProof,
  verifyAttachProof,
} from "@lrm/coforge-sdk/internal/computer-attach-proof";
import { FileMachineAttachSecrets } from "#src/setup/machine-attach-secrets";

test("keeps machine identity and pending request in the protected credential store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-attach-secrets-"));
  const origin = "https://example.test";
  const store = new FileMachineAttachSecrets(origin, directory);
  try {
    const first = await store.identity();
    const reopened = new FileMachineAttachSecrets("HTTPS://EXAMPLE.TEST:443/", directory);
    const second = await reopened.identity();
    expect(second.publicKey).toEqual(first.publicKey);
    const challenge = {
      origin,
      sessionId: crypto.randomUUID(),
      purpose: "complete" as const,
      nonce: "fixture",
    };
    const signature = await signAttachProof(second.privateKey, challenge);
    expect(await verifyAttachProof(first.publicKey, challenge, signature)).toBe(true);

    const pending = {
      sessionId: challenge.sessionId,
      pollSecret: "test-only",
      expiresAt: Date.now() + 5000,
    };
    await store.savePending("team", pending);
    expect(await reopened.loadPending("team")).toEqual(pending);
    expect(await reopened.loadPending("other")).toBeNull();
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of await readdir(directory))
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    await reopened.clearPending("team");
    expect(await store.loadPending("team")).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
