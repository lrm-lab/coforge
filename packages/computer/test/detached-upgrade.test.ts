import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerUpgradeJobPaths } from "@lrm/coforge-daemon";
import type { UpgradeReceiptFile } from "@lrm/coforge-daemon";
import { runDetachedUpgrade } from "#src/release/detached-upgrade";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const REQUEST_ID = "0194f1c2-aaaa-7bbb-8ccc-ddddeeeeffff";

async function home() {
  const root = await mkdtemp(join(tmpdir(), "coforge-detached-upgrade-"));
  roots.push(root);
  return root;
}

/** One receipt as the Daemon's reader returns it. */
const receipt = (status: "succeeded" | "failed"): UpgradeReceiptFile => ({
  result: { schema_version: 1, request_id: REQUEST_ID, operation: "upgrade", status },
  modifiedAt: 1,
});

describe("running an upgrade outside this process", () => {
  test("launches the one-shot with the request id and reads its receipt", async () => {
    const homeDirectory = await home();
    const launched: [string, string][] = [];
    let reads = 0;
    const outcome = await runDetachedUpgrade({
      version: "0.1.18-dev.2",
      requestId: REQUEST_ID,
      homeDirectory,
      installRoot: join(homeDirectory, "install"),
      stateDirectory: join(homeDirectory, "daemon"),
      launch: async (requestId, version) => {
        launched.push([requestId, version]);
      },
      readReceipt: async () => {
        reads++;
        return reads >= 3 ? receipt("succeeded") : undefined;
      },
      sleep: async () => {},
      now: () => reads,
      timeoutMs: 100,
      onLine: () => {},
      onNote: () => {},
    });
    expect(launched).toEqual([[REQUEST_ID, "0.1.18-dev.2"]]);
    expect(outcome).toEqual({
      kind: "settled",
      requestId: REQUEST_ID,
      result: expect.objectContaining({ status: "succeeded" }),
    });
    expect(reads).toBe(3);
  });

  test("a failed receipt is the operation's answer, not an error", async () => {
    const homeDirectory = await home();
    const outcome = await runDetachedUpgrade({
      version: "0.1.18-dev.2",
      requestId: REQUEST_ID,
      homeDirectory,
      installRoot: homeDirectory,
      launch: async () => {},
      readReceipt: async () => ({
        ...receipt("failed"),
        result: { ...receipt("failed").result, error: "installer refused the target" },
      }),
      sleep: async () => {},
      onLine: () => {},
      onNote: () => {},
    });
    expect(outcome).toMatchObject({
      kind: "settled",
      result: { status: "failed", error: "installer refused the target" },
    });
  });

  test("the job's log lines arrive as they are written, and the tail on settle", async () => {
    const homeDirectory = await home();
    const id = REQUEST_ID;
    const path = computerUpgradeJobPaths(id, { homeDirectory }).logPath;
    await mkdir(join(path, ".."), { recursive: true });
    const lines: string[] = [];
    const notes: string[] = [];
    let reads = 0;
    const outcome = await runDetachedUpgrade({
      version: "0.1.18-dev.2",
      requestId: id,
      homeDirectory,
      installRoot: homeDirectory,
      launch: async () => {
        await writeFile(path, "==> Verifying current version\n==> Resolving targ");
      },
      readReceipt: async () => {
        reads++;
        if (reads === 2) {
          await appendFile(path, "et version\n==> Downloading (12%)\n==> Stopping");
          return undefined;
        }
        if (reads === 3) {
          await appendFile(path, " services\n");
          return receipt("succeeded");
        }
        return undefined;
      },
      sleep: async () => {},
      now: () => reads,
      timeoutMs: 100,
      onLine: (line) => lines.push(line),
      onNote: (line) => notes.push(line),
    });
    expect(outcome.kind).toBe("settled");
    expect(lines).toEqual([
      "==> Verifying current version",
      "==> Resolving target version",
      "==> Downloading (12%)",
      "==> Stopping services",
    ]);
    expect(notes[0]).toContain(id);
  });

  test("watching stops at the deadline, and says the upgrade continues without it", async () => {
    const homeDirectory = await home();
    const notes: string[] = [];
    let clock = 0;
    const outcome = await runDetachedUpgrade({
      version: "0.1.18-dev.2",
      requestId: REQUEST_ID,
      homeDirectory,
      installRoot: homeDirectory,
      launch: async () => {},
      readReceipt: async () => undefined,
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
      timeoutMs: 5_000,
      onLine: () => {},
      onNote: (line) => notes.push(line),
    });
    expect(outcome).toEqual({ kind: "still-running", requestId: REQUEST_ID });
    expect(notes.at(-1)).toContain("continues without this command");
  });

  test("a launch the platform refuses is reported, and nothing is waited on", async () => {
    const homeDirectory = await home();
    let read = 0;
    await expect(
      runDetachedUpgrade({
        version: "0.1.18-dev.2",
        homeDirectory,
        installRoot: homeDirectory,
        launch: async () => {
          throw new Error("external Computer upgrade coordinator was rejected");
        },
        readReceipt: async () => {
          read++;
          return undefined;
        },
        sleep: async () => {},
        onLine: () => {},
        onNote: () => {},
      }),
    ).rejects.toThrow("coordinator was rejected");
    expect(read).toBe(0);
  });

  test("an unreadable receipt is reported with the operation's id", async () => {
    const homeDirectory = await home();
    await expect(
      runDetachedUpgrade({
        version: "0.1.18-dev.2",
        requestId: REQUEST_ID,
        homeDirectory,
        installRoot: homeDirectory,
        launch: async () => {},
        readReceipt: async () => {
          throw new Error("not a receipt");
        },
        sleep: async () => {},
        onLine: () => {},
        onNote: () => {},
      }),
    ).rejects.toThrow(`${REQUEST_ID}`);
  });
});
