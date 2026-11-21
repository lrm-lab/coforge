import { expect, test } from "bun:test";
import { getLogger } from "@logtape/logtape";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDaemonLogging } from "#src/platform/daemon-logging";
import { daemonLogPath } from "#src/platform/daemon-log-file";

const tempRoot = realpathSync(tmpdir());

async function writtenLines(directory: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(daemonLogPath(directory), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a compaction line keeps its token counts, and credentials are still redacted", async () => {
  const directory = await mkdtemp(join(tempRoot, "coforge-log-redaction-"));
  try {
    await configureDaemonLogging(directory);
    getLogger(["coforge", "daemon", "test"]).info("Context compaction ended", {
      event: "agent.runtime.compaction_tokens",
      agent_id: "agent-a",
      outcome: "finished",
      tokens_before: 112_630,
      tokens_after: 25_000,
      tokens_source: "runtime",
      window_tokens: 200_000,
      tokens_before_age_ms: 900_001,
      tokens_before_stale: true,
      runtime_pre_tokens: 120_000,
      runtime_post_tokens: 28_000,
      token: "fixture-value",
      access_token: "fixture-value",
      api_key: "fixture-value",
      tokens_key: "fixture-value",
      tokens_before_age_ms_token: "fixture-value",
      runtime_session_tokens: "fixture-value",
    });

    const line = (await writtenLines(directory)).find(
      (record) => record.event === "agent.runtime.compaction_tokens",
    );
    expect(line).toMatchObject({
      tokens_before: 112_630,
      tokens_after: 25_000,
      tokens_source: "runtime",
      window_tokens: 200_000,
      tokens_before_age_ms: 900_001,
      tokens_before_stale: true,
      runtime_pre_tokens: 120_000,
      runtime_post_tokens: 28_000,
    });
    for (const field of [
      "token",
      "access_token",
      "api_key",
      "tokens_key",
      "tokens_before_age_ms_token",
      "runtime_session_tokens",
    ])
      expect(line).not.toHaveProperty(field);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
