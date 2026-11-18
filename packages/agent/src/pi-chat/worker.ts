import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PiChatFiles } from "./files";
import { Database } from "bun:sqlite";
import {
  piChatCommandSchema,
  PI_CHAT_SHUTDOWN_GRACE_MS,
  type PiChatUpdate,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { createPiChatRuntime, listPiChatModels } from "./runtime";
import { FilePiChatStore } from "./storage";
import { PiChatSessions, type WorkbenchCodex } from "./sessions";

/** JSONL over docker-exec stdio; this worker opens no network port or Daemon connection. */
export async function runPiChatWorker(
  root: string,
  workspaceId: string,
  userId: string,
  options: {
    shutdownTimeoutMs?: number;
    stream?: boolean;
    codex?: (directory: string, notify: (update: PiChatUpdate) => void) => WorkbenchCodex;
  } = {},
) {
  const directory = join(root, z.uuid().parse(workspaceId), z.uuid().parse(userId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const write = process.stdout.write.bind(process.stdout);
  const streamId = crypto.randomUUID();
  let sequence = 0;
  const updates = new Map<string, PiChatUpdate>();
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const flushUpdates = () => {
    clearTimeout(updateTimer);
    updateTimer = undefined;
    for (const update of updates.values())
      write(
        `${JSON.stringify({ event: { ...update, stream: { id: streamId, sequence: ++sequence } } })}\n`,
      );
    updates.clear();
  };
  const notify = (update: PiChatUpdate) => {
    if (!options.stream) return;
    const previous = updates.get(update.sessionId);
    const messages = new Map((previous?.messages ?? []).map((message) => [message.id, message]));
    for (const id of update.removeIds ?? []) messages.delete(id);
    for (const message of update.messages ?? []) messages.set(message.id, message);
    updates.set(update.sessionId, {
      ...previous,
      ...update,
      messages: [...messages.values()],
      removeIds: [...new Set([...(previous?.removeIds ?? []), ...(update.removeIds ?? [])])],
    });
    if (update.session || update.deleted) flushUpdates();
    else updateTimer ??= setTimeout(flushUpdates, 40);
  };
  const codex = options.codex?.(directory, notify);
  const store = await FilePiChatStore.open(directory, codex);
  const cwd = store.cwd;
  const owner = new Database(join(cwd, ".chat-owner.sqlite"));
  try {
    owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    owner.close();
    throw error;
  }
  const sessions = new PiChatSessions(
    store,
    (id, model, runtime) => {
      if (runtime !== RUNTIME_PROVIDER.CODEX)
        return createPiChatRuntime(cwd, id, undefined, notify, model);
      if (!codex) return Promise.reject(new Error("Codex runtime is unavailable"));
      return codex.open(id);
    },
    notify,
    () => listPiChatModels(cwd),
  );
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const beginShutdown = () => {
    shutdownTimer ??= setTimeout(
      () => process.exit(1),
      options.shutdownTimeoutMs ?? PI_CHAT_SHUTDOWN_GRACE_MS,
    );
  };
  const stop = () => {
    beginShutdown();
    void sessions.dispose().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const envelope = z.object({ id: z.uuid(), command: piChatCommandSchema });
  const jobs = new Set<Promise<void>>();
  const files = new PiChatFiles(cwd);
  // SDK extensions may log; protocol output uses the saved writer, all logs go to stderr.
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
        flushUpdates();
        const stream = { id: streamId, sequence };
        const command = request.command;
        const execution =
          command.action === "files" || command.action === "file" || command.action === "upload"
            ? command.runtime === RUNTIME_PROVIDER.CODEX
              ? Promise.reject(new Error("Codex workbench file browsing is unavailable"))
              : files.execute(command)
            : sessions.execute(command);
        const task = execution.then(
          (result) => {
            write(
              `${JSON.stringify({ id: request.id, result: options.stream ? { ...result, stream } : result })}\n`,
            );
          },
          (error: unknown) => {
            const message =
              error instanceof Error &&
              /^(session (not found|is busy)|request belongs|Codex runtime is unavailable)/.test(
                error.message,
              )
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
    beginShutdown();
    try {
      await Promise.allSettled(jobs);
      await sessions.dispose();
      flushUpdates();
    } finally {
      clearTimeout(shutdownTimer);
      owner.close();
      console.log = log;
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  }
}
