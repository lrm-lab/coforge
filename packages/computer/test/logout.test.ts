import { expect, test } from "bun:test";

import { ComputerLogout } from "#src/logout";
import type { CredentialRemover } from "#src/login";

test("logout removes the current server credential and preserves attached bindings", async () => {
  const removed: string[] = [];
  const output: string[] = [];
  const remover: CredentialRemover = {
    async remove(serverUrl) {
      removed.push(serverUrl);
    },
  };

  const result = await new ComputerLogout({
    store: remover,
    writeLine: (line) => output.push(line),
  }).run({ serverUrl: "https://coforge.example/", json: false });

  expect(result).toEqual({ serverUrl: "https://coforge.example" });
  expect(removed).toEqual(["https://coforge.example"]);
  expect(output).toEqual(["Result:      Logout complete. Existing Workspace bindings were kept."]);
});

test("JSON logout emits one stable result without credentials", async () => {
  const output: string[] = [];
  await new ComputerLogout({
    store: { async remove() {} },
    writeLine: (line) => output.push(line),
  }).run({ serverUrl: "https://coforge.example", json: true });

  expect(output).toEqual([
    JSON.stringify({
      ok: true,
      server_url: "https://coforge.example",
      bindings_kept: true,
    }),
  ]);
});
