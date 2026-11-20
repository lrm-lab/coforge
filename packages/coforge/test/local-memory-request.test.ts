import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CliError } from "#src/cli-error";
import { connectLocal } from "#src/local-client";
import { parseMemoryArgs } from "#src/memory-commands";

const client = () => connectLocal("", `sfp_${"a".repeat(43)}`, "http://proxy.test");
afterEach(() => mock.restore());

test("a conflicting save names the entry to reread and preserves the failed write", async () => {
  const invocation = parseMemoryArgs([
    "save",
    "--key",
    "lesson",
    "--title",
    "Lesson",
    "--content",
    "Confirmed",
    "--source",
    "Task 1",
  ]);
  if (invocation.scope === "team") throw new Error("Expected local command");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ errorCode: "memory_conflict", error: "conflict" }, { status: 409 }),
  );
  const failure = await client().memory!(invocation.request).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CliError);
  const error = failure as CliError;
  expect(error.code).toBe("MEMORY_CONFLICT");
  expect(error.retryable).toBe(false);
  expect(error.suggestedNextAction).toContain("coforge memory get --key lesson");
  expect(error.suggestedNextAction).toContain("--revision");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(invocation.request);
});

test("non-conflict memory errors do not suggest overwriting an entry", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ errorCode: "memory_invalid", error: "invalid" }, { status: 400 }),
  );
  await expect(client().memory!({ operation: "get", key: "lesson" })).rejects.toMatchObject({
    code: "MEMORY_INVALID",
    retryable: false,
    suggestedNextAction: undefined,
  });
});
