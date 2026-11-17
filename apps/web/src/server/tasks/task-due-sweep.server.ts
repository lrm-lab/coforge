import {
  centrifugoServerApiConfigured,
  createCentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { sweepDueTasks, TASK_DUE_SWEEP_INTERVAL_MS } from "./task-due-worker.server";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

export function ensureTaskDueSweep(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TASK_DUE_SWEEP_INTERVAL_MS);
  onServerShutdown(() => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const db = getDatabaseClient();
    if (db) {
      const centrifugo = centrifugoServerApiConfigured() ? createCentrifugoServerApi() : undefined;
      await sweepDueTasks(db, centrifugo, new Date());
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "task.due_sweep_failed", error_type: errorType(error) }));
  } finally {
    ticking = false;
  }
}
