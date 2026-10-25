import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Two namespaces carry credentials-adjacent data: `daemon` carries the runtime sign-in code a
 * person pastes on the web, and `runtimeauth` carries the sign-in link and device code. Centrifugo
 * keeps a channel's publications for later subscribers only when the namespace sets history, so
 * neither may.
 */
const REPO_ROOT = join(import.meta.dir, "../../..");
const CONFIGS = [
  "infra/centrifugo/config.yaml",
  "infra/staging/centrifugo/config.yaml",
  "infra/production/centrifugo/config.yaml",
];
const NO_HISTORY = ["daemon", "runtimeauth"];

/** The lines of one namespace under the top-level `channel:` block. */
function namespaceBlock(config: string, name: string): string[] {
  const lines = config.split("\n");
  const channel = lines.findIndex((line) => /^channel:\s*$/.test(line));
  expect(channel).toBeGreaterThanOrEqual(0);
  const start = lines.findIndex(
    (line, index) => index > channel && new RegExp(`^ {4}- name: ${name}\\s*$`).test(line),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}- name:/.test(line) || /^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

for (const config of CONFIGS) {
  for (const name of NO_HISTORY) {
    test(`${config}: the ${name} namespace keeps no history`, async () => {
      const block = namespaceBlock(await readFile(join(REPO_ROOT, config), "utf8"), name);
      expect(block.join("\n")).not.toMatch(/history_size|history_ttl|force_recovery/);
    });
  }
}
