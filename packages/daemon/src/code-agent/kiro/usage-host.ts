import {
  type OwnedProcessTree,
  type ProcessTreeSpawner,
  UsageUnavailableError,
  withDeadline,
} from "@lrm/coforge-anvil";
import { KIRO_USAGE_TIMEOUT_MS, parseKiroWhoami } from "@lrm/coforge-anvil/kiro";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";

const KIRO_USAGE_COMMAND = ["kiro-cli", "chat", "--no-interactive", "/usage"] as const;

const logger = getLogger(["coforge", "daemon", "kiro-usage"]);

/** Why a Kiro usage read gave up. Logged as a stable code so a failure keeps a reason without
 * recording the command's own output. */
type KiroUsageFailureReason =
  | "timeout"
  | "not_logged_in"
  | "device_login"
  | "nonzero_exit"
  | "empty_output"
  | "spawn_failed"
  | "unexpected";

class KiroUsageFailure extends Error {
  constructor(readonly reason: KiroUsageFailureReason) {
    super(`Kiro usage read failed: ${reason}`);
  }
}

/** Spawns the CLI's process tree, naming a spawn that throws rather than leaving it unexplained. */
function spawnTree(
  spawner: ProcessTreeSpawner,
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): OwnedProcessTree {
  try {
    return spawner.spawn(command, cwd, environment, { terminal: false });
  } catch {
    throw new KiroUsageFailure("spawn_failed");
  }
}

export type KiroUsageHostOptions = Readonly<{
  workingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  spawn?: ProcessTreeSpawner;
  resolveExecutable?: (environment: Readonly<Record<string, string>>) => string | undefined;
  tempDirectory?: Readonly<{
    create(): Promise<string>;
    remove(path: string): Promise<void>;
  }>;
}>;

/** Runs Kiro's documented `/usage` command without reading its credential store. */
export async function readKiroUsageResponse(options: KiroUsageHostOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const environment = agentEnvironment(undefined, options.environment ?? Bun.env, platform, {
    extraEnv: { NO_COLOR: "1", TERM: "dumb" },
  });
  const executable =
    options.resolveExecutable?.(environment) ??
    resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.KIRO, environment, platform) ??
    "kiro-cli";
  const directory = options.tempDirectory ?? {
    create: () => mkdtemp(join(tmpdir(), "coforge-kiro-usage-")),
    remove: (path: string) => rm(path, { recursive: true, force: true }),
  };
  let workingDirectory: string | undefined;
  let tree: OwnedProcessTree | undefined;
  let earlyStop: Promise<void> | undefined;
  try {
    workingDirectory = await directory.create();
    const deadlineAt = Date.now() + (options.timeoutMs ?? KIRO_USAGE_TIMEOUT_MS);
    const withBudget = <T>(work: Promise<T>) => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return Promise.reject(new KiroUsageFailure("timeout"));
      return withDeadline(work, remainingMs, () => new KiroUsageFailure("timeout"));
    };
    tree = spawnTree(
      options.spawn ?? processSpawner,
      [executable, "whoami", "--format", "json"],
      workingDirectory,
      environment,
    );
    const identity = await withBudget(collectOutput(tree));
    await cleanupOwnedTree(tree, tree.child).catch(() => {});
    tree = undefined;
    if (parseKiroWhoami(identity.stdout).state !== "logged_in")
      throw new KiroUsageFailure("not_logged_in");
    if (deadlineAt <= Date.now()) throw new KiroUsageFailure("timeout");
    tree = spawnTree(
      options.spawn ?? processSpawner,
      [executable, ...KIRO_USAGE_COMMAND.slice(1)],
      workingDirectory,
      environment,
    );
    const result = await withBudget(
      collectOutput(tree, (chunk) => {
        if (!earlyStop && /device\?user_code=|Logging in\.\.\./u.test(chunk))
          earlyStop = cleanupOwnedTree(tree!, tree!.child).catch(() => {});
      }),
    );
    if (result.exitCode !== 0 || earlyStop)
      throw new KiroUsageFailure(earlyStop ? "device_login" : "nonzero_exit");
    const output = result.stdout.includes("Estimated Usage")
      ? result.stdout
      : result.stderr.includes("Estimated Usage")
        ? result.stderr
        : result.stdout;
    if (!output.trim()) throw new KiroUsageFailure("empty_output");
    return output;
  } catch (error) {
    logger.warning("Kiro usage read failed", {
      event: "kiro_usage:read_failed",
      reason: error instanceof KiroUsageFailure ? error.reason : "unexpected",
      outcome: "unavailable",
    });
    throw new UsageUnavailableError();
  } finally {
    if (tree) await (earlyStop ?? cleanupOwnedTree(tree, tree.child)).catch(() => {});
    if (workingDirectory) await directory.remove(workingDirectory).catch(() => {});
  }
}

async function collectOutput(tree: OwnedProcessTree, onChunk?: (chunk: string) => void) {
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(tree.child.stdout, onChunk),
    readStream(tree.child.stderr, onChunk),
    tree.child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function readStream(
  stream: AsyncIterable<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    onChunk?.(Bun.stripANSI(text));
  }
  const tail = decoder.decode();
  onChunk?.(Bun.stripANSI(tail));
  return output + tail;
}
