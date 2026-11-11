import { expect, test } from "bun:test";
import { getLogger } from "@logtape/logtape";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDaemonLogging } from "#src/platform/daemon-logging";
import { daemonLogPath } from "#src/platform/daemon-log-file";

const tempRoot = realpathSync(tmpdir());

/** Reads the JSON lines written so far, skipping any line still being flushed. */
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
    // A real logger, the real sink chain: what the daemon writes, not what a helper returns.
    getLogger(["coforge", "daemon", "test"]).info("Context compaction ended", {
      event: "agent.runtime.compaction_tokens",
      agent_id: "agent-a",
      outcome: "finished",
      tokens_before: 112_630,
      tokens_after: 25_000,
      tokens_source: "runtime",
      window_tokens: 200_000,
      // Credential-shaped: the sink must still drop these, or the narrowed pattern above is a leak.
      token: "sk_live_must_not_appear",
      api_key: "must_not_appear_either",
      tokens_key: "looks_like_a_count_but_is_a_secret",
    });
    // The sink flushes every record; a turn of the event loop is enough for the file write.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const line = (await writtenLines(directory)).find(
      (record) => record.event === "agent.runtime.compaction_tokens",
    );
    expect(line).toMatchObject({
      tokens_before: 112_630,
      tokens_after: 25_000,
      tokens_source: "runtime",
      window_tokens: 200_000,
    });
    for (const field of ["token", "api_key", "tokens_key"])
      expect(line && field in line ? line[field] : undefined).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
