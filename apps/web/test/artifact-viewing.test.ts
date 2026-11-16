import { expect, test } from "bun:test";
import { RedisArtifactViewing } from "#src/server/artifacts/artifact-viewing.server";

test("a heartbeat is one round trip that also drops the expired viewers", async () => {
  const sent: { command: string; args: string[] }[] = [];
  const viewing = new RedisArtifactViewing(
    {
      send: async (command, args) => {
        sent.push({ command, args });
        return 1;
      },
    },
    () => 1_000,
  );
  await viewing.mark("artifact-1", "user-1");
  expect(sent).toHaveLength(1);
  const [{ command, args }] = sent as [(typeof sent)[number]];
  expect(command).toBe("EVAL");
  expect(args.slice(1)).toEqual([
    "1",
    "coforge:artifact-viewing:v1:artifact-1",
    "46000",
    "user-1",
    "90000",
    "1000",
  ]);
  for (const step of ["ZADD", "PEXPIRE", "ZREMRANGEBYSCORE"]) expect(args[0]).toContain(step);
});
