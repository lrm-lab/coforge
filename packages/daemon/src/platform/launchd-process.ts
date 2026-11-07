import { chmodSync, mkdtempSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
  AgentProcessCleanupError,
  PROCESS_TREE_EXIT_GRACE_MS,
  withDeadline,
} from "@lrm/coforge-anvil";
import {
  assertAgentJobScope,
  LaunchdJob,
  launchdJobs,
  processGroupExists,
  stopLaunchdJobs,
} from "./launchd-job";
import { ProcessChannel } from "./process-channel";
import { hostProcessTable, killTurnDescendantsInWindow } from "./process-table";
import type {
  OwnedProcessTree,
  ProcessTreeSpawner,
  ProcessTreeSpawnOptions,
} from "@lrm/coforge-anvil";
import { RuntimeExecutableNotFoundError } from "./runtime-executable-not-found";

/** Agent relay sockets stay outside the state tree: a socket path must fit macOS's 104 bytes. */
export const AGENT_RELAY_ROOT = "/private/tmp";

/** How long an owner waits for its Agent job to start and connect before giving it up. */
export const AGENT_STARTUP_TIMEOUT_MS = 10_000;

/** A relay directory's name: its Workspace's launchd identity, then `mkdtemp`'s six characters.
 * The name is the one pattern; the sweep, the plist scan and the runner check derive from it. */
const RELAY_NAME = "cf-agent-[a-f0-9]{24}-[A-Za-z0-9]{6}";
// AGENT_RELAY_ROOT holds no regular-expression metacharacter.
const RELAY_SOCKET = new RegExp(`^${AGENT_RELAY_ROOT}/${RELAY_NAME}/stdio\\.sock$`);

/** `cf-agent-<identity>-`: the name prefix of one Workspace's Agent relay directories. */
export function agentRelayDirectoryPrefix(prefix: string): string {
  return `cf-agent-${assertAgentJobScope(prefix)}-`;
}

/** Stops every Agent job of one Workspace, then removes the relay directories they leave. */
export async function stopLaunchdAgents(prefix: string, directory: string): Promise<void> {
  await stopLaunchdJobs(prefix, directory);
  await sweepAgentRelayDirectories(prefix, directory, { jobs: await launchdJobs() });
}

/**
 * Removes this Workspace's relay directories that no loaded Agent job's plist names: an owner
 * killed before its own cleanup leaves its directory behind. Another Workspace's directories, the
 * random names of earlier releases, and anything that is not this user's own directory are never
 * touched. A directory younger than the startup timeout is kept, because its owner creates it
 * before its job is loaded. One entry that cannot be removed does not stop the rest.
 */
export async function sweepAgentRelayDirectories(
  prefix: string,
  directory: string,
  options: { jobs: Map<string, number>; root?: string },
): Promise<void> {
  const relayPrefix = agentRelayDirectoryPrefix(prefix);
  const logger = getLogger(["coforge", "daemon", "launchd"]);
  const referenced = new Set<string>();
  for (const label of options.jobs.keys()) {
    if (!label.startsWith(prefix)) continue;
    let plist: string;
    try {
      plist = await readFile(join(directory, `${label}.plist`), "utf8");
    } catch (error) {
      logger.warn("Agent relay sweep skipped: a loaded Agent job's plist is unreadable", {
        event: "launchd:relay_sweep_skipped",
        label,
        error_message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const [name] of plist.matchAll(new RegExp(RELAY_NAME, "g"))) referenced.add(name);
  }
  const root = options.root ?? AGENT_RELAY_ROOT;
  const relayName = new RegExp(`^${RELAY_NAME}$`);
  let failure: unknown;
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch (error) {
    failure = error;
  }
  for (const name of names) {
    if (!name.startsWith(relayPrefix) || !relayName.test(name) || referenced.has(name)) continue;
    try {
      const entry = await lstat(join(root, name));
      if (
        !entry.isDirectory() ||
        entry.uid !== process.getuid!() ||
        Date.now() - entry.mtimeMs < AGENT_STARTUP_TIMEOUT_MS
      )
        continue;
      await rm(join(root, name), { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined)
    logger.warn("Agent relay sweep failed", {
      event: "launchd:relay_sweep_failed",
      error_message: failure instanceof Error ? failure.message : String(failure),
    });
}

/** Provider-neutral stdio over a private socket to an OS-owned job. */
export class LaunchdProcessOwner implements ProcessTreeSpawner {
  constructor(private readonly options: { directory: string; prefix: string; runner: string[] }) {}

  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    options?: ProcessTreeSpawnOptions,
  ): OwnedProcessTree {
    const executable = command[0] && Bun.which(command[0], { cwd, PATH: environment.PATH ?? "" });
    if (!executable) throw new RuntimeExecutableNotFoundError(command[0] ?? "");
    const root = mkdtempSync(
      join(AGENT_RELAY_ROOT, agentRelayDirectoryPrefix(this.options.prefix)),
    );
    chmodSync(root, 0o700);
    const socketPath = join(root, "stdio.sock");
    const job = new LaunchdJob({
      directory: this.options.directory,
      label: `${this.options.prefix}${crypto.randomUUID()}`,
      command: [...this.options.runner, socketPath],
    });
    let processId: number | undefined;
    let jobPid: number | undefined;
    let exitCode: number | null = null;
    // `undefined` until the runner reports the provider child's own ending; a job stopped
    // or failed without that report cannot prove a signal did not end it.
    let exitSignal: string | null | undefined;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        stdout = controller;
      },
    });
    const errors = new ReadableStream<Uint8Array>({
      start(controller) {
        stderr = controller;
      },
    });
    let cleanupFailed = false;
    let closed = false;
    let connected = false;
    let cleanup: Promise<void> | undefined;
    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      stdout.close();
      stderr.close();
      resolveExit(code);
    };
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    const channel = new ProcessChannel((record) => {
      if (record.type === "hello" && Number.isSafeInteger(record.pid)) {
        void started
          .then((identity) => {
            if (identity.mainPid !== record.pid) throw new Error("Agent job identity mismatch");
            channel.send({
              type: "start",
              command: [executable, ...command.slice(1)],
              cwd,
              environment,
              terminal: options?.terminal ?? false,
              ...(options?.terminalSize ? { terminalSize: options.terminalSize } : {}),
            });
          })
          .catch(fail);
      } else if (record.type === "started" && Number.isSafeInteger(record.pid)) {
        processId = Number(record.pid);
        readyResolve();
      } else if (
        (record.type === "stdout" || record.type === "stderr") &&
        typeof record.data === "string"
      ) {
        if (!closed)
          (record.type === "stdout" ? stdout : stderr).enqueue(Buffer.from(record.data, "base64"));
      } else if (record.type === "cleanup_failed" && options?.terminal) {
        cleanupFailed = true;
        getLogger(["coforge", "daemon", "launchd"]).error("Terminal process cleanup failed", {
          event: "launchd:terminal_cleanup_failed",
        });
        finish(1);
        void forceStop().catch(() => {});
      } else if (record.type === "exit" && Number.isInteger(record.code)) {
        exitSignal =
          typeof record.signal === "string" || record.signal === null ? record.signal : undefined;
        finish(Number(record.code));
      } else throw new Error("invalid Agent job response");
    });
    const fail = (_error: unknown) => {
      if (closed) return;
      if (options?.terminal) {
        cleanupFailed = true;
        getLogger(["coforge", "daemon", "launchd"]).error("Terminal process cleanup failed", {
          event: "launchd:terminal_cleanup_failed",
        });
      }
      readyReject(new Error("native Agent job failed"));
      finish(1);
      void stop().catch(() => {});
    };
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          if (connected) {
            socket.terminate();
            return;
          }
          connected = true;
          channel.attach(socket);
        },
        data(_socket, bytes) {
          try {
            channel.read(bytes);
          } catch (error) {
            fail(error);
          }
        },
        drain() {
          try {
            channel.drain();
          } catch (error) {
            fail(error);
          }
        },
        close() {
          fail(new Error("Agent job disconnected"));
        },
        error(_socket, error) {
          fail(error);
        },
      },
    });
    chmodSync(socketPath, 0o600);
    const started = job.ensureStarted().then((identity) => {
      jobPid = identity.mainPid;
      return identity;
    });
    void started.catch(fail);
    const startupTimeout = setTimeout(
      () => fail(new Error("Agent job startup timeout")),
      AGENT_STARTUP_TIMEOUT_MS,
    );
    void ready.then(
      () => clearTimeout(startupTimeout),
      () => clearTimeout(startupTimeout),
    );
    function stop(): Promise<void> {
      return (cleanup ??= (async () => {
        await started.catch(() => {});
        await job.stop();
        channel.close();
        server.stop(true);
        finish(exitCode ?? 1);
        readyReject(new Error("Agent job stopped"));
        await rm(root, { recursive: true, force: true });
      })());
    }
    async function forceStop() {
      try {
        await job.signal("SIGKILL");
      } catch {
        /* stop() verifies job removal and process-group exit below. */
      }
      await stop();
    }
    let writes = Promise.resolve();
    const send = (record: Record<string, unknown>) => {
      writes = writes.then(async () => {
        await ready;
        channel.send(record);
        await channel.flush();
      });
      void writes.catch(fail);
    };
    const signal = (value: string) => {
      // The runner can exit and close the relay between the caller's liveness
      // check and this write landing; a rejected signal write is not a cleanup
      // failure — the bounded exit check alone decides that. Swallowing here
      // also keeps the write chain usable for later sends.
      writes = writes
        .then(async () => {
          await ready;
          channel.send({ type: "signal", signal: value });
          await channel.flush();
        })
        .catch(() => {});
    };
    return {
      child: {
        get pid() {
          return processId;
        },
        get exitCode() {
          return exitCode;
        },
        get exitSignal() {
          return exitSignal;
        },
        exited,
        stdout: output,
        stderr: errors,
        stdin: {
          write(value) {
            send({ type: "stdin", data: value });
            return true;
          },
          end() {
            if (!closed) send({ type: "end" });
          },
          flush: () => writes,
        },
        kill(signal = "SIGTERM") {
          if (!closed) send({ type: "signal", signal });
        },
      },
      terminate: async (force) => {
        if (!options?.terminal) return stop();
        try {
          if (!closed) {
            signal(force ? "SIGKILL" : "SIGTERM");
            await writes;
          }
          if (force)
            await withDeadline(
              exited,
              PROCESS_TREE_EXIT_GRACE_MS,
              () => new AgentProcessCleanupError(),
            );
        } catch (error) {
          cleanupFailed = true;
          getLogger(["coforge", "daemon", "launchd"]).error("Terminal process cleanup failed", {
            event: "launchd:terminal_cleanup_failed",
          });
          throw error;
        } finally {
          if (force) await forceStop();
        }
      },
      terminateForTurn: async (force) => {
        if (!closed) signal(force ? "SIGKILL" : "SIGTERM");
        return { killed: [], leftAlone: [] };
      },
      killTurnDescendants: async (startedAfterMs, startedBeforeMs) => {
        // The agent child runs inside this job's runner, so its ppid is the runner's pid —
        // not this daemon's. That pair, reported over the private relay, is the ownership proof.
        const agentPid = processId;
        const runnerPid = jobPid;
        if (closed || agentPid === undefined || runnerPid === undefined)
          return { killed: [], leftAlone: [] };
        return killTurnDescendantsInWindow(
          hostProcessTable,
          agentPid,
          runnerPid,
          startedAfterMs,
          startedBeforeMs,
        );
      },
      waitForExit: async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        if (cleanupFailed) throw new AgentProcessCleanupError();
        while (!closed || (!options?.terminal && jobPid && (await processGroupExists(jobPid)))) {
          if (Date.now() >= deadline) return false;
          await Bun.sleep(20);
        }
        // Terminal cleanup releases the loaded job only after the TERM/KILL ladder has
        // observed its runner exit. Existing pipe/turn ownership keeps its original lifecycle.
        if (options?.terminal) await stop();
        if (cleanupFailed) throw new AgentProcessCleanupError();
        return true;
      },
    };
  }
}

/** The one relay socket shape the owner creates: `/` or `..` cannot enter either name segment. */
export function isAgentRelaySocket(path: string): boolean {
  return RELAY_SOCKET.test(path);
}
