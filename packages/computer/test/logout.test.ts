import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileComputerConfig } from "#src/local-config";
import { FileCredentialStore } from "#src/credential-store";
import { ComputerLogout } from "#src/logout";
import type { CredentialRemover } from "#src/login";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

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

test("logout preserves the profile and Workspace registration files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-logout-"));
  temporaryDirectories.push(root);
  const serverUrl = "https://coforge.example";
  const config = new FileComputerConfig(join(root, "config"));
  const store = new FileCredentialStore(join(root, "credentials"));
  await config.saveCurrentProfile({ serverUrl });
  await config.saveRegistration({ id: "workspace-1", slug: "acme", computerId: "computer-1" });
  await store.save(serverUrl, { accessToken: "secret", tokenType: "Bearer" });

  await new ComputerLogout({ store, writeLine: () => {} }).run({ serverUrl });

  await expect(store.load(serverUrl)).resolves.toBeNull();
  await expect(config.loadCurrentProfile()).resolves.toEqual({ serverUrl });
  await expect(config.loadRegistration("workspace-1")).resolves.toEqual({
    id: "workspace-1",
    slug: "acme",
    computerId: "computer-1",
  });
});
