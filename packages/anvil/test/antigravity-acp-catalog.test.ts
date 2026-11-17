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
    const methods = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).method);
    expect(methods).toContain("session/close");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
