import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { piChatCommandSchema } from "@lrm/coforge-sdk/internal/pi-chat";
import { createPiChatRuntime } from "./runtime";
import { FilePiChatStore } from "./storage";
import { PiChatSessions } from "./sessions";

/** JSONL over docker-exec stdio; this worker opens no network port or Daemon connection. */
export async function runPiChatWorker(root: string, workspaceId: string, userId: string) {
  const cwd = join(root, z.uuid().parse(workspaceId), z.uuid().parse(userId));
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const sessions = new PiChatSessions(new FilePiChatStore(cwd), (id) =>
    createPiChatRuntime(cwd, id),
  );
  const stop = () => {
    void sessions.dispose().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const envelope = z.object({ id: z.uuid(), command: piChatCommandSchema });
  const jobs = new Set<Promise<void>>();
  // SDK extensions may log; protocol output uses the saved writer, all logs go to stderr.
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  console.log = console.error;
  try {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1_000_000) throw new Error("chat request too large");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const request = envelope.parse(JSON.parse(line));
        const task = sessions.execute(request.command).then(
          (result) => {
            write(`${JSON.stringify({ id: request.id, result })}\n`);
          },
          (error: unknown) => {
            const message =
              error instanceof Error &&
              /^(session (not found|is busy)|request belongs)/.test(error.message)
                ? error.message
                : "Pi request failed. Check the cloud computer model configuration.";
            write(`${JSON.stringify({ id: request.id, error: message })}\n`);
          },
        );
        jobs.add(task);
        void task.finally(() => jobs.delete(task));
      }
    }
  } finally {
    await Promise.allSettled(jobs);
    await sessions.dispose();
    console.log = log;
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
