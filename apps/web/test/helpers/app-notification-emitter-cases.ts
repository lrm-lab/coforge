import { afterAll, beforeAll, expect, test } from "bun:test";

import type { AppNotificationEventName } from "#src/features/apps/app-notification-events";
import {
  emitterDatabaseUrl,
  startEmitterEnvironment,
  type EmitterEnvironment,
  type RefusedCommit,
} from "./app-notification-emitters";

export type EmitterFixture = Awaited<ReturnType<EmitterEnvironment["fixture"]>>;

/** One event an area emits, as the three things every emitter owes. */
export type EmitterCase<Context> = {
  type: AppNotificationEventName;
  /** What distinguishes this case from another of the same event (its operation). */
  label?: string;
  /** Makes what the operation acts on, before the Workspace's guard is installed. */
  setup(env: EmitterEnvironment, fixture: EmitterFixture): Promise<Context>;
  /** The real domain operation that changes the thing. */
  act(env: EmitterEnvironment, fixture: EmitterFixture, context: Context): Promise<unknown>;
  /** The `data` of the one event it records. */
  data(fixture: EmitterFixture, context: Context): unknown;
  /** How many other events of the type the operation records beside that one (default none). */
  others?: number;
  /** A row the operation writes, whose commit is refused to roll the operation back. */
  refuse(fixture: EmitterFixture, context: Context): RefusedCommit;
};

/** A case with its context type closed over, so cases of different areas share one list. */
export type EmitterCaseRegistration = { register(environment: () => EmitterEnvironment): void };

export const emitterCase = <Context>(emitter: EmitterCase<Context>): EmitterCaseRegistration => ({
  register(environment) {
    const testWithDatabase = emitterDatabaseUrl ? test : test.skip;
    const label = `${emitter.type} (${emitter.label ?? "domain operation"})`;

    testWithDatabase(`${label}: one event with the flag on`, async () => {
      const env = environment();
      const fixture = await env.fixture();
      try {
        const context = await emitter.setup(env, fixture);
        await emitter.act(env, fixture, context);
        const events = await env.recorded(fixture.workspace.id, emitter.type);
        expect(events).toHaveLength(1 + (emitter.others ?? 0));
        expect(events.every((event) => event.workspaceId === fixture.workspace.id)).toBe(true);
        expect(events.map((event) => event.data as unknown)).toContainEqual(
          emitter.data(fixture, context),
        );
      } finally {
        await fixture.cleanup();
      }
    });

    testWithDatabase(`${label}: nothing with the flag off`, async () => {
      const env = environment();
      const fixture = await env.fixture({ flag: "off" });
      try {
        const context = await emitter.setup(env, fixture);
        await emitter.act(env, fixture, context);
        expect(await env.recorded(fixture.workspace.id, emitter.type)).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    testWithDatabase(`${label}: nothing when the operation rolls back`, async () => {
      const env = environment();
      const fixture = await env.fixture();
      try {
        const context = await emitter.setup(env, fixture);
        const lift = await env.refuseCommit(emitter.refuse(fixture, context));
        try {
          await expect(emitter.act(env, fixture, context)).rejects.toThrow("commit refused");
        } finally {
          await lift();
        }
        expect(await env.recorded(fixture.workspace.id, emitter.type)).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });
  },
});

/**
 * Starts the emitter environment around the suite and defines, for each case, the three tests every
 * emitter has: with the flag on the operation records exactly one event of the type with the
 * expected data; with it off nothing is recorded; and an operation whose commit fails records
 * nothing. Returns the environment, for the extra tests an area adds.
 */
export function defineEmitterCases(cases: readonly EmitterCaseRegistration[]) {
  let env: EmitterEnvironment;
  beforeAll(async () => {
    if (emitterDatabaseUrl) env = await startEmitterEnvironment();
  });
  afterAll(async () => {
    await env?.stop();
  });
  for (const emitter of cases) emitter.register(() => env);
  return () => env;
}
