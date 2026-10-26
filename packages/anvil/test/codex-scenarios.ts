import { fixtureCodexHost } from "./fixtures/codex-host";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

/** A provider on the scenarios fake app-server; `args` are its argv flags (`scenario=`, `log=`). */
export function scenarioProvider(...args: string[]): CodexProvider {
  return new CodexProvider({
    host: fixtureCodexHost,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server-scenarios.ts", import.meta.url).pathname,
      ...args,
    ],
  });
}

export async function waitForEvent(
  events: AgentRuntimeEvent[],
  type: AgentRuntimeEvent["type"],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${type}`);
}
