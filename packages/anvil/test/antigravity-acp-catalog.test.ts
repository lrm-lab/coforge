import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAntigravityAcpCatalog } from "#src/antigravity/acp-catalog";
import { fixtureAntigravityHost } from "./fixtures/antigravity-host";

const command = [
  process.execPath,
  new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname,
];

test("each model carries the thought_level choices agy publishes once that model applies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-catalog-"));
  try {
    const log = join(cwd, "rpc.jsonl");
    const catalog = await discoverAntigravityAcpCatalog(
      command,
      cwd,
      { AGY_ACP_FIXTURE_LOG: log },
      fixtureAntigravityHost,
      10_000,
    );
    expect(catalog?.models).toEqual([
      expect.objectContaining({
        id: "gemini-4-carbon",
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoning: "medium",
        recommended: true,
      }),
      expect.objectContaining({
        id: "gemini-4-hydrogen",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoning: "medium",
        recommended: false,
      }),
      expect.objectContaining({
        id: "gpt-oss-120b-medium",
        reasoningEfforts: [],
        defaultReasoning: "",
        recommended: false,
      }),
    ]);
    const calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    const methods = calls.map((entry) => entry.method);
    expect(methods).toContain("session/close");
    const closeIndex = methods.lastIndexOf("session/close");
    const configBeforeClose = calls
      .slice(0, closeIndex)
      .filter((entry) => entry.method === "session/set_config_option")
      .map((entry) => [entry.params?.configId, entry.params?.value]);
    expect(configBeforeClose.slice(-2)).toEqual([
      ["model", "gemini-4-carbon"],
      ["thought_level", "medium"],
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("catalog discovery passes session flags and forwards GEMINI_HOME as --gemini-dir", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-catalog-"));
  try {
    const spawned: (readonly string[])[] = [];
    const capturingHost = {
      ...fixtureAntigravityHost,
      processTreeSpawner: {
        spawn: (cmd: readonly string[], dir: string, env: Readonly<Record<string, string>>) => {
          spawned.push(cmd);
          return fixtureAntigravityHost.processTreeSpawner.spawn(cmd, dir, env);
        },
      },
    };
    await discoverAntigravityAcpCatalog(command, cwd, {}, capturingHost, 10_000);
    await discoverAntigravityAcpCatalog(
      command,
      cwd,
      { GEMINI_HOME: "/tmp/custom-gemini" },
      capturingHost,
      10_000,
    );
    expect(spawned.map((cmd) => cmd.slice(command.length))).toEqual([
      ["acp", "--dangerously-skip-permissions", "--process-per-session"],
      [
        "acp",
        "--dangerously-skip-permissions",
        "--process-per-session",
        "--gemini-dir",
        "/tmp/custom-gemini",
      ],
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a timed-out catalog probe skips restore and close RPCs instead of multiplying the timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-catalog-timeout-"));
  try {
    const log = join(cwd, "rpc.jsonl");
    const started = Date.now();
    const catalog = await discoverAntigravityAcpCatalog(
      command,
      cwd,
      { AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_HANG_CONFIG: "gemini-4-hydrogen" },
      fixtureAntigravityHost,
      200,
    );
    const elapsed = Date.now() - started;
    expect(catalog).toBeUndefined();
    expect(elapsed).toBeLessThan(650);
    const methods = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).method);
    expect(methods).not.toContain("session/close");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
