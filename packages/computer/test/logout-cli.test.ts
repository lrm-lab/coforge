import { expect, test } from "bun:test";

import { runCli } from "#src/cli";
import { COFORGE_SERVER_URL } from "#src/release-channel";

test("logout forwards JSON mode to the command", async () => {
  const calls: Array<{ serverUrl: string; json: boolean }> = [];
  const exitCode = await runCli(["logout", "--json"], {
    login: { async run() {} },
    logout: {
      async run(serverUrl, options) {
        calls.push({ serverUrl, json: options.json });
      },
    },
    setup: { async run() {} },
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([{ serverUrl: COFORGE_SERVER_URL, json: true }]);
});
