import { expect, test } from "bun:test";

import { daemonConnectHeaders } from "#src/connection/daemon-connect-headers";

test("sends the API key as a header and omits the instance id when there is none", () => {
  expect(daemonConnectHeaders("dk_key")).toEqual({ "X-CoForge-Daemon-Api-Key": "dk_key" });
});

test("adds the runtime instance id so the proxy can match this process's reconnects", () => {
  expect(daemonConnectHeaders("dk_key", "runtime-1")).toEqual({
    "X-CoForge-Daemon-Api-Key": "dk_key",
    "X-CoForge-Daemon-Instance-Id": "runtime-1",
  });
});
