import { spawnOwnedChild } from "./process-transport";
import { PosixProcessOwner } from "./posix-process-tree";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";
import { ProcessChannel } from "./process-channel";
import type { OwnedChildProcess, OwnedProcessTree } from "@lrm/coforge-anvil";
import { isAgentRelaySocket } from "./launchd-process";

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
        (record.terminal !== undefined && typeof record.terminal !== "boolean") ||
        (record.terminalSize !== undefined &&
          (typeof record.terminalSize !== "object" ||
            record.terminalSize === null ||
            !Number.isSafeInteger((record.terminalSize as { cols?: unknown }).cols) ||
            !Number.isSafeInteger((record.terminalSize as { rows?: unknown }).rows) ||
            (record.terminalSize as { cols: number }).cols <= 0 ||
            (record.terminalSize as { rows: number }).rows <= 0))
      )
        throw new Error("invalid Agent start");
      if (record.terminal === true) {
        terminalTree = new PosixProcessOwner().spawn(
          record.command,
          record.cwd,
          record.environment as Record<string, string>,
          {
            terminal: true,
            ...(record.terminalSize
              ? {
                  terminalSize: record.terminalSize as {
                    cols: number;
                    rows: number;
                  },
                }
              : {}),
          },
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
            } catch (error) {
              channel.send({
                type: "cleanup_failed",
                reason: error instanceof Error ? error.message : String(error),
              });
              await channel.flush();
              process.exit(1);
            }
          }
          // A descendant can retain stdio after its parent exits; never wait forever.
          await Promise.race([drained, Bun.sleep(1000)]);
          channel.send({ type: "exit", code, signal: child?.exitSignal });
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
        void terminalTree.terminate(record.signal === "SIGKILL").catch((error: unknown) => {
          channel.send({
            type: "cleanup_failed",
            reason: error instanceof Error ? error.message : String(error),
          });
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
