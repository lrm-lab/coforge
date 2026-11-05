import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetachedDaemonHost } from "@lrm/coforge-daemon";
import { acceptingConnect } from "./accepting-connect";
import { recordingRegistrar } from "./recording-registrar";

/** A machine without systemd where the person already runs `coforge-computer foreground`
 * (task #538, from QA's #417 run): attach and setup use it and start nothing of their own. */
async function host(connect: Parameters<typeof acceptingConnect>[0] | "down") {
  const registrar = recordingRegistrar(
    connect === "down" ? new Error("installer start") : undefined,
  );
  const stateDirectory = await mkdtemp(join(tmpdir(), "detached-running-"));
  const refused = Object.assign(new Error("no daemon"), { code: "ENOENT" });
  return {
    registrar,
    host: new DetachedDaemonHost({
      homeDirectory: "/home/alice",
      executablePath: "/install/coforge-computer",
      socketPath: join(stateDirectory, "daemon.sock"),
      stateDirectory,
      serverUrl: "https://coforge.test",
      registrar,
      processStartedAt: async () => null,
      connect:
        connect === "down"
          ? async () => {
              throw refused;
            }
          : acceptingConnect(connect),
    }),
  };
}

test("a Computer that already answers the local handshake is used, not started again", async () => {
  const { host: h, registrar } = await host("https://coforge.test");
  await h.ensureRunning();
  expect(registrar.calls).toBe(0);
});

test("with nothing running the installer is asked to start it, once", async () => {
  const { host: h, registrar } = await host("down");
  await expect(h.ensureRunning()).rejects.toThrow("installer start");
  expect(registrar.calls).toBe(1);
});
