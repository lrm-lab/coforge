import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { codexWorkbench } from "@lrm/coforge-anvil/codex";
import type { PiChatUpdate } from "@lrm/coforge-sdk/internal/pi-chat";
import { processSpawner } from "#src/code-agent/process-host";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";

export function createWorkbenchCodex(directory: string, notify: (event: PiChatUpdate) => void) {
  const environment = Object.fromEntries(
    Object.entries(Bun.env).flatMap(([key, value]) =>
      value !== undefined && !key.startsWith("COFORGE_") ? [[key, value]] : [],
    ),
  );
  return codexWorkbench(
    async () => {
      const cwd = join(await realpath(directory), "codex");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      if ((await realpath(cwd)) !== cwd) throw new Error("Codex workbench directory is redirected");
      return cwd;
    },
    {
      command: () => {
        const executable = resolveHostCodeAgentExecutable("codex", environment);
        if (!executable) throw new Error("Codex runtime is unavailable");
        return [executable, "app-server", "--listen", "stdio://"];
      },
      environment,
      spawner: processSpawner,
      notify,
    },
  );
}
