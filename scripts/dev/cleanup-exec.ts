// Runs a child process to completion for `mise run cleanup` (scripts/dev/cleanup.ts).

export type CommandResult = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

export type RunOptions = { cwd?: string; env?: Record<string, string>; timeout?: number };

/** Runs a command; tests inject a stand-in where a real one would reach the network or the host. */
export type Runner = (command: string[], options?: RunOptions) => Promise<CommandResult>;

export const run: Runner = async (command, options = {}) => {
  const child = Bun.spawn(command, {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr, timedOut: child.signalCode !== null };
};

export const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
