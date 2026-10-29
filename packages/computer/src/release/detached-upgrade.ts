import { homedir } from "node:os";
import {
  computerUpgradeJobPaths,
  launchComputerUpgrade,
  readUpgradeReceipt,
  resolveComputerInstallDirectory,
} from "@lrm/coforge-daemon";
import type { UpgradeResult } from "@lrm/coforge-sdk/internal/upgrade-receipt";
import { UpdateError } from "#src/updater";

/** How long a caller waits for the job's receipt before it stops watching. The job itself
 * continues either way: it is outside this process, which is the point. */
export const DETACHED_UPGRADE_TIMEOUT_MS = 30 * 60_000;
export const DETACHED_UPGRADE_POLL_MS = 1_000;

export type DetachedUpgradeOptions = {
  /** The version the operation moves to, validated by the caller's own plan. */
  version: string;
  /** The operation's durable id; a caller that already has one (a retry) passes it. */
  requestId?: string;
  installRoot?: string;
  stateDirectory?: string;
  homeDirectory?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** A line the job wrote to its own log, as it arrives. */
  onLine?: (line: string) => void;
  /** A note about the operation itself (its id, or that watching stopped). */
  onNote?: (line: string) => void;
  /** Tests inject these; production uses the Daemon's platform layer. */
  launch?: typeof launchComputerUpgrade;
  readReceipt?: typeof readUpgradeReceipt;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DetachedUpgradeOutcome =
  | { kind: "settled"; requestId: string; result: UpgradeResult }
  | { kind: "still-running"; requestId: string };

/**
 * Moves this Computer to `version` through an OS one-shot job (systemd-run / a launchd job /
 * a Scheduled Task) and waits for its receipt. The job is outside this process on every
 * platform, so the caller being stopped — by the upgrade itself, an Agent's session ending, or
 * a Ctrl-C — cannot leave the machine half-switched: the job finishes and writes its receipt.
 * `still-running` means only that this process stopped watching, never that the upgrade stopped.
 */
export async function runDetachedUpgrade(
  options: DetachedUpgradeOptions,
): Promise<DetachedUpgradeOutcome> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const installRoot = options.installRoot ?? resolveComputerInstallDirectory();
  const home = options.homeDirectory ?? homedir();
  const launch = options.launch ?? launchComputerUpgrade;
  const readReceipt = options.readReceipt ?? readUpgradeReceipt;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const onLine = options.onLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const note = options.onNote ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logPath = computerUpgradeJobPaths(requestId, {
    stateDirectory: options.stateDirectory,
    homeDirectory: home,
  }).logPath;

  note(`Upgrade ${requestId} starts outside this process; its result is kept on this Computer.`);
  await launch(requestId, options.version, {
    stateDirectory: options.stateDirectory,
    homeDirectory: home,
  });

  const deadline = now() + (options.timeoutMs ?? DETACHED_UPGRADE_TIMEOUT_MS);
  const pollMs = options.pollMs ?? DETACHED_UPGRADE_POLL_MS;
  const log = new UpgradeLogFollower(logPath, onLine);
  for (;;) {
    const receipt = await readReceipt(installRoot, requestId).catch((error: unknown) => {
      // A receipt that exists but cannot be read is the operation's own evidence of failure.
      throw new UpdateError(
        "UPDATE_FEED_INVALID",
        `upgrade ${requestId} left an unreadable receipt: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (receipt) {
      await log.flush();
      return { kind: "settled", requestId, result: receipt.result };
    }
    await log.follow();
    if (now() >= deadline) {
      await log.flush();
      note(
        `Still running after ${Math.round((options.timeoutMs ?? DETACHED_UPGRADE_TIMEOUT_MS) / 60_000)} minutes; the upgrade continues without this command.`,
      );
      return { kind: "still-running", requestId };
    }
    await sleep(pollMs);
  }
}

/** Prints the job's log as it grows: the upgrade's own progress lines, from every platform that
 * writes them. A missing file is not an error — the job may not have started writing yet. */
class UpgradeLogFollower {
  #offset = 0;
  #partial = "";

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
  ) {}

  async follow(): Promise<void> {
    await this.#read(false);
  }

  /** The last lines of a finished operation, including one without a trailing newline. */
  async flush(): Promise<void> {
    await this.#read(true);
  }

  async #read(final: boolean): Promise<void> {
    let text: string;
    try {
      text = await Bun.file(this.path).text();
    } catch {
      return;
    }
    if (text.length <= this.#offset) return;
    const grown = this.#partial + text.slice(this.#offset);
    this.#offset = text.length;
    const lines = grown.split("\n");
    this.#partial = final ? "" : (lines.pop() ?? "");
    if (final && lines.length === 0 && grown.length > 0) lines.push(grown);
    for (const line of lines) if (line.trim()) this.onLine(line);
  }
}
