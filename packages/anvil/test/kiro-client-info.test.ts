import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { KiroConnection } from "#src/kiro/connection";
import { fixtureKiroHost } from "./fixtures/kiro-host";

function command(clientInfo: { name: string; version: string }) {
  return [
    process.execPath,
    new URL("./fixtures/kiro-client-info.ts", import.meta.url).pathname,
    "--catalog",
    `--expect-client-info=${JSON.stringify(clientInfo)}`,
  ];
}

test("Kiro initialize sends the host's exact clientInfo", async () => {
  const clientInfo = { name: "fixture-host-719", version: "9.8.7-fixture" };
  const transport = new KiroConnection(
    command(clientInfo),
    tmpdir(),
    {},
    { ...fixtureKiroHost, clientInfo },
  );
  try {
    expect((await transport.initialize()).protocolVersion).toBe(1);
  } finally {
    await transport.dispose();
  }
});
