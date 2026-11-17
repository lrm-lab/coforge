import { getDatabaseClient } from "#src/server/db/client.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { createReminderDueWorker } from "./reminder-due-composition.server";
import { REMINDER_DUE_INTERVAL_MS } from "./reminder-due-worker.server";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

export function ensureReminderDueSweep(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), REMINDER_DUE_INTERVAL_MS);
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
    if (db) await createReminderDueWorker(db, createCentrifugoServerApi()).tick(new Date());
  } catch (error) {
    console.error(
      JSON.stringify({ event: "reminder.due_sweep_failed", error_type: errorType(error) }),
    );
  } finally {
    ticking = false;
  }
}
