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

test("an adapter that emits compaction-finished declares reportsCompaction, and only it does", async () => {
  const emitters = await emittingDirectories();
  const mapped = new Set(Object.values(ADAPTER_DIRS).flat());
  // A shared-directory emitter has no adapter to declare it: fail rather than miss it.
  for (const directory of emitters) expect(mapped.has(directory), directory).toBe(true);
  for (const provider of RUNTIME_PROVIDER_VALUES) {
    const directories = ADAPTER_DIRS[provider];
    expect(directories, `no adapter directory mapped for ${provider}`).toBeDefined();
    const emits = directories.some((directory) => emitters.has(directory));
    expect(createCodeAgentProvider(provider).reportsCompaction, provider).toBe(emits);
  }
}, 30_000);
