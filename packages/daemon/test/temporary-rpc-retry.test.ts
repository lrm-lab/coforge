import { expect, test } from "bun:test";
import { isTemporaryRpcError, retryTemporaryRpc } from "#src/connection/temporary-rpc-retry";

/** The error Centrifugo returns when its proxy to the Web container fails. */
function temporaryFailure() {
  return Object.assign(new Error("internal server error"), { code: 100, temporary: true });
}

test("a temporary RPC failure is retried on the bounded delays until it succeeds", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await retryTemporaryRpc(
    async () => {
      attempts++;
      if (attempts < 3) throw temporaryFailure();
    },
    { delays: [10, 20, 30], sleep: async (delayMs) => void sleeps.push(delayMs) },
  );
  expect(attempts).toBe(3);
  expect(sleeps).toEqual([10, 20]);
});

test("a temporary failure after every delay is thrown to the caller", async () => {
  let attempts = 0;
  await expect(
    retryTemporaryRpc(
      async () => {
        attempts++;
        throw temporaryFailure();
      },
      { delays: [1, 2], sleep: async () => undefined },
    ),
  ).rejects.toMatchObject({ temporary: true });
  expect(attempts).toBe(3);
});

test("a refusal is not retried", async () => {
  let attempts = 0;
  await expect(
    retryTemporaryRpc(
      async () => {
        attempts++;
        throw new Error("forbidden");
      },
      { delays: [1], sleep: async () => undefined },
    ),
  ).rejects.toThrow("forbidden");
  expect(attempts).toBe(1);
});

test("only the server's temporary flag makes an RPC retryable", () => {
  expect(isTemporaryRpcError(temporaryFailure())).toBe(true);
  expect(isTemporaryRpcError(Object.assign(new Error("x"), { temporary: false }))).toBe(false);
  expect(isTemporaryRpcError(new Error("x"))).toBe(false);
  expect(isTemporaryRpcError(undefined)).toBe(false);
});
