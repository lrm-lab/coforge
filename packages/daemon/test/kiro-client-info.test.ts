import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { discoverKiroCatalog } from "@lrm/coforge-anvil";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { COFORGE_DAEMON_VERSION } from "#src/version";

function command(clientInfo: { name: string; version: string }) {
  return [
    process.execPath,
    anvilRuntimeFixtures.kiroClientInfo,
    "--catalog",
    `--expect-client-info=${JSON.stringify(clientInfo)}`,
  ];
}

test("daemon Kiro discovery preserves its wire clientInfo", async () => {
  const catalog = await discoverKiroCatalog(
    command({ name: "coforge-daemon", version: COFORGE_DAEMON_VERSION }),
    tmpdir(),
    {},
    kiroRuntimeHost,
  );
  expect(catalog?.provider).toBe("kiro");
});
