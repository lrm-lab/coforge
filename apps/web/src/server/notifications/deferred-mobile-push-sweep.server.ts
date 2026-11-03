import { requireDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { errorType } from "#src/server/errors/error-type.server";
import { deferredMobilePushes } from "./notification-redis.server";
import { createWebPushNotifications } from "./web-push-composition.server";
import type { WebPushNotifications } from "./web-push-notifications.server";

/** How often waiting people are looked at; a wait ends within this much of its time. */
export const DEFERRED_MOBILE_PUSH_SWEEP_MS = 15_000;
/** Bounds one tick's cost; who is left waits for the next tick. */
const BATCH = 200;
/** People handled at once, so one slow push service does not hold up the rest. */
const CONCURRENCY = 10;

let started = false;
let ticking = false;

/**
 * Every 15 seconds, the people whose phone notifications may now ring (task #467): each is taken
 * from the queue by one web instance alone and looked at (`releaseDeferred`), ten at a time.
 * Inert without `REDIS_URL`. A failed tick is logged and the next one tries again; a person taken
 * and not handled loses their waiting notifications, which costs at most those phone rings.
 */
export function ensureDeferredMobilePushSweep(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void tick(), DEFERRED_MOBILE_PUSH_SWEEP_MS);
  timer.unref();
  onServerShutdown(() => clearInterval(timer));
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const queue = deferredMobilePushes();
    if (!queue) return;
    const due = await queue.takeDuePeople(BATCH, new Date());
    if (due.length === 0) return;
    await releaseAll(await createWebPushNotifications(requireDatabaseClient()), due);
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "web_push.deferred_sweep_failed", error: errorType(error) }),
    );
  } finally {
    ticking = false;
  }
}

/** Looks at each of `people`, `CONCURRENCY` at a time; one failure is logged, never fatal. */
export async function releaseAll(
  notifications: Pick<WebPushNotifications, "releaseDeferred">,
  people: readonly string[],
  concurrency = CONCURRENCY,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < people.length) {
      const userId = people[next++]!;
      try {
        await notifications.releaseDeferred(userId);
      } catch (error) {
        console.warn(
          JSON.stringify({ event: "web_push.deferred_failed", error: errorType(error) }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length) }, worker));
}
