import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { discoverKiroCatalog } from "@lrm/coforge-anvil";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import { captureDaemonLogs } from "./log-capture";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test("catalog failure logs an error code and an honest message instead of asserting a login problem", async () => {
  const { records } = await captureDaemonLogs(async () => {
    expect(
      await discoverKiroCatalog(
        [process.execPath, anvilRuntimeFixtures.kiro, "--catalog", "--missing-config"],
        tmpdir(),
        {},
        kiroRuntimeHost,
        30,
      ),
    ).toBeUndefined();
  });
  const failure = records.find((record) => record.properties.event === "kiro.catalog.unavailable");
  expect(failure?.message.join("")).toBe("Kiro v3 model discovery unavailable");
  expect(failure?.properties.error_code).toEqual(expect.any(String));
});
