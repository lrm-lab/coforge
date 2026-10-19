// Runs a test command without the CoForge identity and Workspace scope of the process that started
// it. Inside a CoForge Agent, a test that inherited them could act as that Agent (send messages,
// change Tasks) or on its Workspace (stop its Agents' jobs, read its credentials). A Bun child
// spawned without `env` gets its parent's startup environment, which no preload can change, so the
// cut happens here, before bun starts. The mise test tasks run their tests through this script.
//
// usage: bun scripts/test/isolated-test-run.ts <command> [args...]
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_BINDING_ENV_KEYS } from "@coforge/computer/src/host/container-binding-env";
import { DAEMON_LAUNCH_ENV_KEYS } from "@lrm/coforge-daemon/src/code-agent/environment";

/** The parent's environment without any Agent's or Workspace's CoForge variables, with the
 * Daemon's state directory at `daemonHome` (its default is the machine's real `~/.coforge/daemon`).
 * Every other variable, CoForge test configuration included, passes unchanged.
 * COFORGE_COMPUTER_HOME is left alone: it moves only the Computer's login credential, which no
 * test reads by default, and `scripts/e2e/run-computer-setup.sh` reuses that credential between
 * runs. */
export function isolatedTestEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  daemonHome: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent))
    if (value !== undefined) environment[name] = value;
  withoutDaemonGitConfig(environment);
  for (const name of [...DAEMON_LAUNCH_ENV_KEYS, ...CONTAINER_BINDING_ENV_KEYS])
    delete environment[name];
  environment.COFORGE_DAEMON_HOME = daemonHome;
  return environment;
}

/** An Agent's Daemon appends its own `GIT_CONFIG_KEY_n`/`VALUE_n` entries (the GitHub credential
 * helper, the hooks directory) after the user's and, when it injects a hooks directory, records
 * the user's count in COFORGE_GIT_CONFIG_BASE_COUNT (`agentEnvironment` in
 * packages/daemon/src/code-agent/environment.ts). Truncates back to that count; without it the
 * Daemon's entries cannot be told from the user's, so all of them stay. */
function withoutDaemonGitConfig(environment: Record<string, string>): void {
  const recorded = environment.COFORGE_GIT_CONFIG_BASE_COUNT;
  const base = recorded ? Number(recorded) : Number.NaN;
  if (!Number.isSafeInteger(base) || base < 0) return;
  const count = Number(environment.GIT_CONFIG_COUNT);
  for (let index = base; index < (Number.isSafeInteger(count) ? count : base); index++) {
    delete environment[`GIT_CONFIG_KEY_${index}`];
    delete environment[`GIT_CONFIG_VALUE_${index}`];
  }
  if (base === 0) delete environment.GIT_CONFIG_COUNT;
  else environment.GIT_CONFIG_COUNT = String(base);
}

async function main(command: string[]): Promise<never> {
  if (command.length === 0) {
    console.error("usage: bun scripts/test/isolated-test-run.ts <command> [args...]");
    process.exit(2);
  }
  // macOS tmpdir lives under /var, a symlink; the Daemon's state stores reject linked ancestors.
  const daemonHome = mkdtempSync(join(realpathSync(tmpdir()), "coforge-test-daemon-home-"));
  let child: Bun.Subprocess | undefined;
  // The terminal signals the whole process group; mise or a supervisor may signal only this
  // process. Either way the child decides how to stop, and this process waits to clean up.
  const forward = (signal: NodeJS.Signals) => () => child?.kill(signal);
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    child = Bun.spawn(command, {
      env: isolatedTestEnvironment(process.env, daemonHome),
      stdio: ["inherit", "inherit", "inherit"],
    });
    await child.exited;
  } finally {
    rmSync(daemonHome, { recursive: true, force: true });
  }
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (child.signalCode) process.kill(process.pid, child.signalCode);
  process.exit(child.exitCode ?? 1);
}

if (import.meta.main) await main(process.argv.slice(2));
