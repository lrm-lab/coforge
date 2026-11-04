import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "bun:test";
import { retireComputerSessionOnce } from "#src/supervisor/retire-session";

/** `retire-session` (task #417 step 3): only a definite server answer — and only while the
 * login file is unchanged — lets the local session go. */
const fixture = async (contents = JSON.stringify({ accessToken: "at", tokenType: "Bearer" })) => {
  const directory = await mkdtemp(join(tmpdir(), "retire-"));
  await writeFile(join(directory, "server.json"), contents);
  return { directory, path: join(directory, "server.json") };
};

const deps = (
  overrides: Partial<Parameters<typeof retireComputerSessionOnce>[0]> = {},
): Parameters<typeof retireComputerSessionOnce>[0] => ({
  workspaceId: "w",
  computerId: "c",
  credentials: { load: async () => "sk_computer_x" },
  selfClient: { retireSession: async () => ({ ok: true as const, value: "retired" as const }) },
  ...overrides,
  serverHttpUrl: overrides.serverHttpUrl ?? "http://server",
});

test("a definite retire answers retired and deletes the login file", async () => {
  const { directory, path } = await fixture();
  const result = await retireComputerSessionOnce(deps({ credentialsDirectory: directory }));
  expect(result).toEqual({ retired: true });
  await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("a retryable answer keeps the login file", async () => {
  const { directory, path } = await fixture();
  const result = await retireComputerSessionOnce(
    deps({
      credentialsDirectory: directory,
      selfClient: {
        retireSession: async () => ({
          ok: false as const,
          error: { kind: "retryable" as const, detail: "http 503" },
        }),
      },
    }),
  );
  expect(result).toEqual({ retired: false, reason: "retryable" });
  expect(await readFile(path, "utf8")).toContain("at");
});

test("the login file goes only if unchanged since the call began", async () => {
  const { directory, path } = await fixture();
  const result = await retireComputerSessionOnce(
    deps({
      credentialsDirectory: directory,
      selfClient: {
        retireSession: async () => {
          // A person rewrote the login while the call was in flight — it is not ours to delete.
          await writeFile(path, JSON.stringify({ accessToken: "newer" }));
          return { ok: true as const, value: "retired" as const };
        },
      },
    }),
  );
  expect(result).toEqual({ retired: true });
  expect(await readFile(path, "utf8")).toContain("newer");
});

test("a scheduled retire cancels before its 20s delay and the login never fires", async () => {
  const { scheduleRetireSession } = await import("#src/supervisor/retire-session");
  const calls: string[] = [];
  const handle = scheduleRetireSession({
    workspaceId: "w",
    computerId: "c",
    serverHttpUrl: "http://server",
    credentials: { load: async () => "sk_computer_x" },
    selfClient: {
      retireSession: async () => {
        calls.push("retire");
        return { ok: true as const, value: "retired" as const };
      },
    },
  });
  handle.stop();
  await Bun.sleep(50);
  expect(calls).toEqual([]);
});

test("the credentials directory follows COFORGE_COMPUTER_CREDENTIALS_DIR and the filename the server URL", async () => {
  // A staged login beside a production one is never picked: `COFORGE_COMPUTER_CREDENTIALS_DIR`
  // names the directory, `computerCredentialFilename(serverHttpUrl)` the file (task #417).
  const directory = await mkdtemp(join(tmpdir(), "retire-env-"));
  await writeFile(
    join(directory, "server-8080.json"),
    JSON.stringify({ accessToken: "at", tokenType: "Bearer" }),
  );
  let retired: string[] = [];
  const done = await retireComputerSessionOnce(
    deps({
      serverHttpUrl: "http://server:8080",
      environment: { COFORGE_COMPUTER_CREDENTIALS_DIR: directory },
      selfClient: {
        retireSession: async (apiKey) => {
          retired.push(apiKey);
          return { ok: true as const, value: "retired" as const };
        },
      },
    }),
  );
  expect(done).toEqual({ retired: true });
  expect(retired).toEqual(["at"]);
});
