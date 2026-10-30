import { expect, test } from "bun:test";
import { killProbeChild, versionProbeOutput } from "#src/code-agent/runtime-probe";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";

type Child = ReturnType<ExternalCodeAgentProbe["spawn"]>;

/** A child whose exit only happens when it is killed, as a hung probe's would. */
function hangingChild() {
  let finish: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const child = {
    stdout: new Blob(["1.2.3\n"]).stream(),
    stderr: new Blob([]).stream(),
    exited,
    kill: () => {
      events.push("kill");
      queueMicrotask(() => {
        events.push("exit");
        finish?.(0);
      });
    },
  } as unknown as Child;
  return { child, events };
}

test("a probe child is gone before its caller can remove the executable", async () => {
  const { child, events } = hangingChild();
  await killProbeChild(child);
  // The wait is the point: on Windows the image stays locked until the process has exited.
  expect(events).toEqual(["kill", "exit"]);
});

test("killing an already-exited child resolves instead of rejecting", async () => {
  const child = {
    stdout: new Blob([]).stream(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  } as unknown as Child;
  await expect(killProbeChild(child)).resolves.toBeUndefined();
});

test("a probe that printed its version returns it without waiting on the budget", async () => {
  const child = {
    stdout: new Blob(["codex 0.151.0\n"]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  } as unknown as Child;
  await expect(versionProbeOutput(child, 1_000)).resolves.toMatchObject({ exitCode: 0 });
});
