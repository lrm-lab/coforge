import { expect, test } from "bun:test";
import { join } from "node:path";
import { RUNTIME_PROVIDER_VALUES, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";

const ANVIL_SRC = new URL("../../anvil/src/", import.meta.url).pathname;

/** The adapter directory each provider runs. `coforge` and `pi` share the embedded Pi adapter. */
const ADAPTER_DIRS: Readonly<Record<RuntimeProvider, readonly string[]>> = {
  coforge: ["pi"],
  pi: ["pi"],
  "claude-code": ["claude-code"],
  codex: ["codex"],
  cursor: ["cursor"],
  grok: ["grok"],
  kiro: ["kiro"],
  opencode: ["opencode"],
  antigravity: ["antigravity"],
  dsh: ["dsh"],
  "command-code": ["command-code"],
  devin: ["devin"],
};

/** The top-level adapter directory of every file that publishes the context-cut event. */
async function emittingDirectories(): Promise<ReadonlySet<string>> {
  const directories = new Set<string>();
  for await (const file of new Bun.Glob("**/*.ts").scan(ANVIL_SRC)) {
    const text = await Bun.file(join(ANVIL_SRC, file)).text();
    if (/type:\s*"compaction-finished"/.test(text)) directories.add(file.split("/")[0]!);
  }
  return directories;
}

test("declaring compaction reporting requires emitting it; receiving it does not require declaring", async () => {
  const emitters = await emittingDirectories();
  for (const provider of RUNTIME_PROVIDER_VALUES) {
    const directories = ADAPTER_DIRS[provider];
    expect(directories, `no adapter directory mapped for ${provider}`).toBeDefined();
    const emits = directories.some((directory) => emitters.has(directory));
    // The declaration enables the context ledger, which lets a read leave out text this context
    // already showed — so an adapter may claim it only when its provider is observed to emit the
    // event. The other direction is fine: an ACP adapter maps `compaction_update` without
    // declaring, its event still re-briefs the memory, and no ledger is enabled.
    if (createCodeAgentProvider(provider).reportsCompaction === true)
      expect(emits, provider).toBe(true);
  }
  // Every ACP adapter can receive the (UNSTABLE) update only because the one shared `initialize`
  // advertises the capability.
  const connection = await Bun.file(join(ANVIL_SRC, "acp", "connection.ts")).text();
  expect(connection).toContain("session: { compaction: {} }");
}, 30_000);
