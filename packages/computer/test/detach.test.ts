import { test, expect } from "bun:test";
import { DaemonCommandRejectedError } from "@lrm/coforge-daemon";

import { detachWorkspace } from "#src/detach/detach";

/** `detach` (task #417 step 3): the local registration goes only on the Daemon's definite
 * `DETACH` answer; `detach_unconfirmed` keeps it and reports that the server never confirmed. */
const registration = { id: "ws-a", slug: "alpha", computerId: "c" };

const deps = (overrides: {
  command?: Parameters<Parameters<typeof detachWorkspace>[0]["daemon"]["command"]>[0] extends never
    ? never
    : Parameters<typeof detachWorkspace>[0]["daemon"]["command"];
  discarded?: string[];
}): Parameters<typeof detachWorkspace>[0] => ({
  daemon: {
    command: overrides.command ?? (async () => [] as never[]),
  },
  config: {
    loadRegistration: async () => registration,
    discardRegistration: async (entry: typeof registration) => {
      overrides.discarded?.push(entry.id);
    },
    loadCurrentProfile: async () => ({ serverUrl: "http://server" }),
  },
});

test("a definite DETACH removes the local registration and reports detached", async () => {
  const discarded: string[] = [];
  const outcome = await detachWorkspace(deps({ discarded }));
  expect(outcome).toEqual({ kind: "detached", workspaceSlug: "alpha" });
  expect(discarded).toEqual(["ws-a"]);
});

test("an unconfirmed DETACH keeps the registration and reports so", async () => {
  const discarded: string[] = [];
  const outcome = await detachWorkspace(
    deps({
      discarded,
      command: async () => {
        throw new DaemonCommandRejectedError(
          "detach",
          "server answer unavailable",
          "detach_unconfirmed",
        );
      },
    }),
  );
  expect(outcome).toEqual({ kind: "unconfirmed", workspaceSlug: "alpha" });
  expect(discarded).toEqual([]);
});

test("a missing registration answers not_attached without calling the daemon", async () => {
  let called = 0;
  const outcome = await detachWorkspace({
    daemon: {
      command: async () => {
        called++;
        return [];
      },
    },
    config: {
      loadRegistration: async () => null,
      discardRegistration: async () => {},
      loadCurrentProfile: async () => ({ serverUrl: "http://server" }),
    },
  });
  expect(outcome).toEqual({ kind: "not_attached" });
  expect(called).toBe(0);
});
