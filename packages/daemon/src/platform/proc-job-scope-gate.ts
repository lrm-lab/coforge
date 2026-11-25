import { resolve } from "node:path";

export type ProcJobScopePayload = {
  command: string[];
  cwd: string;
  env: Record<string, string>;
};

export function procJobScopeGateCommand(): string[] {
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, "__proc-job-scope-gate"]
    : [process.execPath, "run", "--no-env-file", import.meta.path];
}

export async function runProcJobScopeGate(): Promise<void> {
  try {
    const frame = await Bun.stdin.text();
    const { command, cwd, env } = JSON.parse(frame) as ProcJobScopePayload;
    const name = command[0]!;
    process.chdir(cwd);
    const executable = name.includes("/")
      ? resolve(name)
      : Bun.which(name, { PATH: env.PATH ?? "" });
    if (!executable || !process.execve) process.exit(125);
    process.execve(executable, command, env);
  } catch {
    process.exit(125);
  }
}

if (import.meta.main) await runProcJobScopeGate();
