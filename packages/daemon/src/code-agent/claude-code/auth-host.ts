import type { ClaudeAuthHost, ClaudeAuthProcess } from "@lrm/coforge-anvil/claude-code";
import { agentEnvironment } from "#src/code-agent/environment";
import { maskEmail } from "#src/code-agent/mask-email";

function spawnClaudeAuth(
  command: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>> },
): ClaudeAuthProcess {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    write: (text) => {
      child.stdin.write(text);
      child.stdin.flush();
    },
    kill: () => child.kill(),
  };
}

function claudeAuthEnvironment(): Record<string, string> {
  // No browser on this machine: the person signs in from the Web page, not from here.
  return agentEnvironment(undefined, Bun.env, undefined, {
    envVars: undefined,
    extraEnv: {
      NO_COLOR: "1",
      BROWSER:
        process.platform === "win32"
          ? `${Bun.env.SystemRoot ?? "C:\\Windows"}\\System32\\hostname.exe`
          : "true",
    },
  });
}

export const claudeAuthHost: ClaudeAuthHost = {
  buildAuthEnvironment: claudeAuthEnvironment,
  createAuthProcess: spawnClaudeAuth,
  maskAccountLabel: maskEmail,
};
