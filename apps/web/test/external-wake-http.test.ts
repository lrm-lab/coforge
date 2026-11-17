import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { handleWakeStreamGet } from "#src/server/agents/external-wake-http.server";
import { MAX_WAKE_STREAMS_PER_CREDENTIAL } from "#src/server/agents/external-wake-stream.server";

const principal = {
  workspaceId: "w1",
  agentId: "a1",
  credentialId: "cred-http-test",
  external: true,
} as unknown as Parameters<typeof handleWakeStreamGet>[1];

const db = {} as unknown as PrismaClient;

function request(timeout: () => void) {
  const req = new Request("https://coforge.test/wake/stream");
  Object.assign(req, { runtime: { bun: { server: { timeout } } } });
  return req;
}

test("a failure while opening the stream gives its slot back", async () => {
  for (let i = 0; i < MAX_WAKE_STREAMS_PER_CREDENTIAL + 1; i++) {
    expect(() =>
      handleWakeStreamGet(
        request(() => {
          throw new Error("timeout refused");
        }),
        principal,
        db,
      ),
    ).toThrow("timeout refused");
  }
  const response = handleWakeStreamGet(
    request(() => undefined),
    principal,
    db,
  );
  expect(response.status).toBe(200);
  await response.body!.cancel();
});
