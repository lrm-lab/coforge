import { release } from "node:os";

/** The machine's operating system, as the ready report carries it. */
export type OperatingSystem = { platform: string; osVersion: string };

export type OperatingSystemOptions = {
  platform?: string;
  release?: () => string;
  /** Reads a command's stdout; production spawns it without blocking the event loop. */
  run?: (command: string[]) => Promise<string>;
};

const UNKNOWN: OperatingSystem = { platform: "", osVersion: "" };

/**
 * The OS version, read once and kept: it only changes with an upgrade, and the ready report runs
 * on every (re)connect. On macOS the version comes from `sw_vers`, so the read is off the event
 * loop and never on the ready path.
 */
export class OperatingSystemInfo {
  #value: OperatingSystem = UNKNOWN;
  #read: Promise<OperatingSystem> | undefined;

  /** Reads once; every later call, and a failed read, reuses the first answer. */
  read(options: OperatingSystemOptions = {}): Promise<OperatingSystem> {
    this.#read ??= detectOperatingSystem(options).then((value) => {
      this.#value = value;
      return value;
    });
    return this.#read;
  }

  /** What the last completed read found; empty until `read` settles. */
  get current(): OperatingSystem {
    return this.#value;
  }
}

/** One detection pass; empty version means detection failed. */
export async function detectOperatingSystem(
  options: OperatingSystemOptions = {},
): Promise<OperatingSystem> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return UNKNOWN;
  try {
    const osVersion =
      platform === "darwin"
        ? await (options.run ?? run)(["/usr/bin/sw_vers", "-productVersion"])
        : (options.release ?? release)();
    return { platform, osVersion: osVersion.trim() };
  } catch {
    return { platform, osVersion: "" };
  }
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 2_000);
  try {
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0) throw new Error("OS version unavailable");
    return output;
  } finally {
    clearTimeout(timer);
  }
}
