import { expect, test } from "bun:test";
import { InstallerRecoveryReporter } from "#src/connection/installer-recovery-reporter";
import { encodeDaemonConnectionStatus } from "#src/connection/connection-status-payload";

function challenge(generation: number) {
  const token = crypto.randomUUID();
  return {
    token,
    reply: {
      data: new TextEncoder().encode(
        JSON.stringify({ installerRecoveryChallenge: { token, generation } }),
      ),
    },
  };
}

test("a new challenge triggers a fresh read, and repeating a heartbeat reuses its sample", async () => {
  let reads = 0;
  const reporter = new InstallerRecoveryReporter(async () => ++reads === 1);
  const one = challenge(1);
  const two = challenge(2);
  expect(reporter.observation()).toEqual({ requestChallenge: true });
  await reporter.accept({ data: new TextEncoder().encode("{}") });
  expect(reads).toBe(0);
  await reporter.accept(one.reply);
  const pending = reporter.observation();
  expect(pending).toEqual({ challenge: one.token, required: true, sampleSequence: 1 });
  await reporter.accept(one.reply);
  expect(reporter.observation()).toBe(pending);
  await reporter.accept(two.reply);
  expect(reporter.observation()).toEqual({
    challenge: two.token,
    required: false,
    sampleSequence: 2,
  });
  expect(reads).toBe(2);
});

test("slow observations do not block heartbeats, and old reads cannot replace a later one", async () => {
  const first = Promise.withResolvers<boolean>();
  let reads = 0;
  const reporter = new InstallerRecoveryReporter(() => {
    if (++reads === 1) return first.promise;
    return Promise.reject(new Error("journal unavailable"));
  });
  const one = challenge(1);
  const two = challenge(2);
  const prior = reporter.accept(one.reply);
  const bytes = encodeDaemonConnectionStatus(
    { workspaceId: "workspace", computerId: "computer" },
    reporter.observation(),
  );
  expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
    online: true,
    installerRecoveryObservation: { requestChallenge: true },
  });
  await reporter.accept(two.reply);
  first.resolve(true);
  await prior;
  expect(reporter.observation()).toEqual({
    challenge: two.token,
    required: false,
    sampleSequence: 1,
  });
});
