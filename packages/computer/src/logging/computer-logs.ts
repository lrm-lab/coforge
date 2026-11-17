import { readFile } from "node:fs/promises";
import { workspaceStateDirectory } from "@lrm/coforge-daemon";
import { daemonLogPath } from "@lrm/coforge-daemon/src/platform/daemon-log-file";
import { computerLogPath } from "./computer-logger";

export const DEFAULT_LOG_LINES = 200;

export type LogSource = "computer" | "supervisor" | { workspace: string };

export type ComputerLogsOptions = {
  dataDirectory: string;
  write: (line: string) => void;
  lines?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
};

export type ReadComputerLogsOptions = {
  logPath?: string;
  dataDirectory?: string;
  missingMessage?: string;
  lines?: number;
  follow?: boolean;
  write: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
};

export async function resolveLogSourceTarget(input: {
  source: LogSource;
  dataDirectory: string;
  stateDirectory?: string;
  resolveWorkspace?: (selector: string) => Promise<{ id: string; slug: string }>;
}): Promise<{ logPath: string; missingMessage: string }> {
  if (input.source === "computer") {
    const logPath = computerLogPath(input.dataDirectory);
    return {
      logPath,
      missingMessage: `No Computer log exists at ${logPath}. Start the service first (\`coforge-computer start\`).`,
    };
  }
  if (!input.stateDirectory) {
    throw new Error("Daemon state directory is unavailable for daemon logs");
  }
  if (input.source === "supervisor") {
    const logPath = daemonLogPath(input.stateDirectory);
    return {
      logPath,
      missingMessage: `No supervisor daemon log exists at ${logPath}. Start the service first (\`coforge-computer start\`).`,
    };
  }
  if (!input.resolveWorkspace) {
    throw new Error("Workspace lookup is unavailable for workspace logs");
  }
  const resolved = await input.resolveWorkspace(input.source.workspace);
  const logPath = daemonLogPath(workspaceStateDirectory(input.stateDirectory, resolved.id));
  return {
    logPath,
    missingMessage: `No Workspace daemon log exists for '${resolved.slug}' at ${logPath}. Start the Workspace first (\`coforge-computer start --workspace ${resolved.slug}\`).`,
  };
}

/** Read a bounded one-shot tail of a Computer or Daemon log, optionally following new appends. */
export async function readComputerLogs(input: ReadComputerLogsOptions): Promise<void> {
  const path =
    input.logPath ?? (input.dataDirectory ? computerLogPath(input.dataDirectory) : undefined);
  if (!path) throw new Error("readComputerLogs requires logPath or dataDirectory");
  const maxLines =
    input.follow && input.lines === undefined ? undefined : (input.lines ?? DEFAULT_LOG_LINES);
  const chunksNewestFirst: string[][] = [];
  let collectedLines = 0;
  let offset = 0;
  let foundLogFile = false;

  for (const suffix of ["", ".1", ".2", ".3", ".4", ".5"] as const) {
    const content = await readIfPresent(`${path}${suffix}`);
    if (suffix === "") offset = content?.length ?? 0;
    if (content === null) continue;
    foundLogFile = true;
    const fileLines = nonEmptyLines(content);
    if (fileLines.length > 0) {
      chunksNewestFirst.push(fileLines);
      collectedLines += fileLines.length;
    }
    if (maxLines !== undefined && collectedLines >= maxLines) break;
  }

  if (!foundLogFile) {
    throw new Error(
      input.missingMessage ??
        `No Computer log exists at ${path}. Start the service first (\`coforge-computer start\`).`,
    );
  }

  const ordered = chunksNewestFirst.reverse().flat();
  const initialLines =
    maxLines !== undefined && ordered.length > maxLines
      ? ordered.slice(ordered.length - maxLines)
      : ordered;
  for (const line of initialLines) input.write(line);

  if (!input.follow) return;

  const sleep = input.sleep ?? Bun.sleep;
  const signal = input.signal ?? createInterruptSignal();
  while (!signal.aborted) {
    const content = await readIfPresent(path);
    if (content === null) {
      offset = 0;
    } else if (content.length < offset) {
      offset = 0;
      writeLines(content, input.write);
      offset = content.length;
    } else if (content.length > offset) {
      writeLines(content.slice(offset), input.write);
      offset = content.length;
    }
    await sleep(250);
  }
}

/** Print existing Computer logs, then follow the active file until interrupted. */
export async function followComputerLogs(input: ComputerLogsOptions): Promise<void> {
  return readComputerLogs({
    dataDirectory: input.dataDirectory,
    lines: input.lines,
    follow: true,
    write: input.write,
    sleep: input.sleep,
    signal: input.signal,
  });
}

function nonEmptyLines(content: string): string[] {
  return content.split("\n").filter((line) => line.length > 0);
}

function writeLines(content: string, write: (line: string) => void): void {
  for (const line of nonEmptyLines(content)) write(line);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function createInterruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}
