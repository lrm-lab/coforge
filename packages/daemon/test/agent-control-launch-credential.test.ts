import { expect, test } from "bun:test";
import { RuntimeLoginRequiredError, RuntimeStartFailedError } from "@lrm/coforge-anvil";
import { harness, startIntent } from "./fixtures/launch-retry";

// A launch the provider refuses for its credential is a sign-in a person has to do, so the ladder
// stops on the first attempt and the server's Start is answered with that reason instead of
// spending every retry on a key that cannot start working by itself.

test("a login no retry can fix ends the launch on its first failure, without a cooldown", async () => {
  const h = harness(async () => {
    throw new RuntimeLoginRequiredError("Kiro CLI is not logged in on this Computer");
  });

  await h.control.start(startIntent);

  // One attempt, no retry armed, and the server's Start operation is answered right away instead
  // of staying pending for the whole retry window.
  expect(h.launches).toEqual([1]);
  expect(h.timers.delays()).toEqual([]);
  expect(h.results).toHaveLength(1);
  expect(h.results[0]).toMatchObject({ phase: "failed", errorCode: "runtime_login_required" });
  expect(h.record()?.phase).toBe("failed");
});

test("a start the provider refuses in its own words is a sign-in: one attempt, no retry", async () => {
  // What a CLI that exits before it is ready looks like from the outside: a generic start failure
  // whose stderr says the key is refused. Nothing typed distinguishes it, so the words decide, and
  // they decide the same way they would for a failure mid-turn.
  const h = harness(async () => {
    throw new RuntimeStartFailedError(
      "claude exited 1 before it was ready",
      "Invalid API key · Please run /login",
    );
  });

  await h.control.start(startIntent);

  expect(h.launches).toEqual([1]);
  expect(h.timers.delays()).toEqual([]);
  expect(h.results).toHaveLength(1);
  expect(h.results[0]).toMatchObject({ phase: "failed", errorCode: "runtime_login_required" });
  expect(h.record()?.phase).toBe("failed");
});
