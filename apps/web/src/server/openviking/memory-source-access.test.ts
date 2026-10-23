import { expect, test } from "bun:test";
import { createMemorySourceAccess } from "./memory-source-access.server";

function access(forward: () => Promise<unknown>) {
  return createMemorySourceAccess({
    bindings: { get: async () => ({ accountId: "acct" }) },
    gateway: { forward } as never,
  });
}

test("an experience card source is readable inside its own account without an fs/stat", async () => {
  let stats = 0;
  const can = access(async () => {
    stats += 1;
    throw new Error("must not stat a card");
  });
  const uri = "viking://resources/causal/cards/abc";
  expect(await can("w", "task", { accountId: "acct", uri })).toBe(true);
  expect(stats).toBe(0);
  expect(await can("w", "task", { accountId: "other", uri })).toBe(false);
});

test("a filesystem source is still stat-checked", async () => {
  const can = access(async () => ({
    ok: true,
    response: { status: 404, body: { cancel: async () => undefined } },
  }));
  expect(
    await can("w", "task", { accountId: "acct", uri: "viking://resources/x" }),
  ).toBe(false);
});
