import { chmodSync, mkdtempSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { spawnOwnedChild } from "./process-transport";
import { PosixProcessOwner } from "./posix-process-tree";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";
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
import type {
  OwnedChildProcess,
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
    return {
      child: {
        get pid() {
          return processId;
        },
        get exitCode() {
          return exitCode;
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
            send({ type: "signal", signal: force ? "SIGKILL" : "SIGTERM" });
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
        if (!closed) send({ type: "signal", signal: force ? "SIGKILL" : "SIGTERM" });
        return { killed: [], leftAlone: [] };
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

/** Internal executable mode. No arguments or credentials are persisted in the plist. */
export async function runLaunchdAgent(socketPath: string): Promise<void> {
  if (!isAgentRelaySocket(socketPath ?? "")) throw new Error("invalid Agent relay socket");
  let child: OwnedChildProcess | undefined;
  let terminalTree: OwnedProcessTree | undefined;
  let terminalCleanup: Promise<void> | undefined;
  const cleanTerminal = () => (terminalCleanup ??= cleanupOwnedTree(terminalTree!, child!));
  const shutdown = () => {
    if (terminalTree) void cleanTerminal().finally(() => process.exit(1));
    else process.exit(1);
  };
  process.on("SIGTERM", () => {
    if (terminalTree) shutdown();
    else if (child) child.kill("SIGTERM");
    else process.exit(0);
  });
  let input = Promise.resolve();
  const channel = new ProcessChannel((record) => {
    if (record.type === "start") {
      if (
        child ||
        !Array.isArray(record.command) ||
        !record.command.length ||
        !record.command.every((arg) => typeof arg === "string") ||
        typeof record.cwd !== "string" ||
        !record.environment ||
        typeof record.environment !== "object" ||
        Array.isArray(record.environment) ||
        !Object.values(record.environment).every((value) => typeof value === "string") ||
        (record.terminal !== undefined && typeof record.terminal !== "boolean")
      )
        throw new Error("invalid Agent start");
      if (record.terminal === true) {
        terminalTree = new PosixProcessOwner().spawn(
          record.command,
          record.cwd,
          record.environment as Record<string, string>,
          { terminal: true },
        );
        child = terminalTree.child;
      } else
        child = spawnOwnedChild(
          record.command,
          record.cwd,
          record.environment as Record<string, string>,
        );
      channel.send({ type: "started", pid: child.pid });
      const relay = async (stream: AsyncIterable<Uint8Array>, type: string) => {
        for await (const data of stream) {
          channel.send({ type, data: Buffer.from(data).toString("base64") });
          await channel.flush();
        }
      };
      const drained = Promise.all([relay(child.stdout, "stdout"), relay(child.stderr, "stderr")]);
      void drained.catch(() => process.exit(1));
      void child.exited
        .then(async (code) => {
          if (terminalTree) {
            try {
              await cleanTerminal();
            } catch {
              channel.send({ type: "cleanup_failed" });
              await channel.flush();
              process.exit(1);
            }
          }
          // A descendant can retain stdio after its parent exits; never wait forever.
          await Promise.race([drained, Bun.sleep(1000)]);
          channel.send({ type: "exit", code });
          await channel.flush();
          process.exit(code);
        })
        .catch(() => process.exit(1));
    } else if (record.type === "stdin" && child && typeof record.data === "string") {
      const target = child;
      input = input.then(async () => {
        target.stdin.write(record.data as string);
        await target.stdin.flush();
      });
      void input.catch(() => process.exit(1));
    } else if (record.type === "end" && child) {
      const target = child;
      void input.then(() => target.stdin.end());
    } else if (
      record.type === "signal" &&
      child &&
      ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(record.signal))
    ) {
      if (terminalTree && record.signal !== "SIGINT") {
        void terminalTree.terminate(record.signal === "SIGKILL").catch(() => {
          channel.send({ type: "cleanup_failed" });
          void channel.flush().finally(shutdown);
        });
      } else child.kill(record.signal as "SIGINT" | "SIGTERM" | "SIGKILL");
    } else throw new Error("invalid Agent relay request");
  });
  await Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        channel.attach(socket);
        channel.send({ type: "hello", pid: process.pid });
      },
      data(_socket, data) {
        try {
          channel.read(data);
        } catch {
          shutdown();
        }
      },
      drain() {
        try {
          channel.drain();
        } catch {
          shutdown();
        }
      },
      close() {
        shutdown();
      },
      error() {
        shutdown();
      },
    },
  });
}
