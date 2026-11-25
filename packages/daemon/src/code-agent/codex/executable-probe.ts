import {
  AgentProcessCleanupError,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  withDeadline,
} from "@lrm/coforge-anvil";
import { cleanupOwnedTree, JsonlProcess } from "@lrm/coforge-anvil/execution";
import { initializeCodex } from "@lrm/coforge-anvil/codex";
import { processSpawner } from "#src/code-agent/process-host";
import { codexClientInfo } from "./host";

export const CODEX_PROBE_TIMEOUT_MS = CATALOG_DISCOVERY_TIMEOUT_MS;
export const CODEX_PROBE_BUDGET_MULTIPLIER = 2;

export async function probeCodexExecutable(
  executable: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = performance.now() + timeoutMs;
  const timeout = () => new Error("Codex executable probe timed out");
  const appServer = new JsonlProcess(
    [executable, "app-server"],
    process.cwd(),
    environment,
    processSpawner,
  );
  await withDeadline(
    initializeCodex(appServer, timeoutMs, codexClientInfo),
    timeoutMs,
    timeout,
  ).finally(async () => {
    await appServer.dispose();
    if (appServer.exitInfo().cleanupUnconfirmed) throw new AgentProcessCleanupError();
  });

  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw timeout();
  const tree = processSpawner.spawn([executable, "--version"], process.cwd(), environment);
  const { child } = tree;
  try {
    const [output, exitCode] = await withDeadline(
      Promise.all([readOutput(child.stdout), child.exited, readOutput(child.stderr)]),
      remainingMs,
      timeout,
    );
    return exitCode === 0 ? output.trim().split(/\s+/).pop() || undefined : undefined;
  } finally {
    await cleanupOwnedTree(tree, child);
  }
}

async function readOutput(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  return output + decoder.decode();
}
