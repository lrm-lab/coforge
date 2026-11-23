import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  reportWorkspaceCredentials,
  scanWorkspaceCredentials,
} from "#src/host/workspace-credential-scan";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-credential-scan-"));
  directories.push(directory);
  return directory;
}

test("reports an account file holding a plaintext password", async () => {
  const root = await workspace();
  await writeFile(join(root, ".info"), "username=lijian40\npassword=Sup3rSecretValue\n");

  const findings = await scanWorkspaceCredentials(root);

  expect(findings).toHaveLength(1);
  expect(findings[0]?.path).toBe(join(root, ".info"));
  expect(findings[0]?.reasons).toContain("credential file name");
  expect(findings[0]?.reasons).toContain("assigned secret");
});

test("reports a private key and keeps the key material out of the log", async () => {
  const root = await workspace();
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEow".repeat(8)}\n-----END RSA PRIVATE KEY-----\n`;
  await writeFile(join(root, "id_rsa"), key);
  const lines: string[] = [];

  const found = await reportWorkspaceCredentials(root, (line) => lines.push(line));

  expect(found).toBe(1);
  expect(lines.join("\n")).toContain("private key");
  expect(lines.join("\n")).not.toContain("MIIEow");
});

test("reports a provider key assigned inside a configuration file", async () => {
  const root = await workspace();
  await mkdir(join(root, "conf"));
  await writeFile(
    join(root, "conf", "models.json"),
    JSON.stringify({ apiKey: "sk-proj-abcdefghijklmnopqrstuvwx" }),
  );

  const findings = await scanWorkspaceCredentials(root);

  expect(findings.map((finding) => finding.reasons)).toEqual([["provider key"]]);
});

test("ignores code that only references an environment variable", async () => {
  const root = await workspace();
  await writeFile(
    join(root, "bootstrap.sh"),
    'TEAM_API_KEY="${TEAM_API_KEY:-}"\napiKey: process.env.TEAM_API_KEY,\n',
  );

  expect(await scanWorkspaceCredentials(root)).toEqual([]);
});

test("ignores installed dependencies and ordinary project files", async () => {
  const root = await workspace();
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "id_rsa"), "-----BEGIN PRIVATE KEY-----\n");
  await writeFile(join(root, "README.md"), "Notes about the project.\n");

  expect(await scanWorkspaceCredentials(root)).toEqual([]);
});

test("stops before directories nested below the scan depth", async () => {
  const root = await workspace();
  const deep = join(root, "a", "b", "c", "d", "e");
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "id_rsa"), "-----BEGIN PRIVATE KEY-----\n");

  expect(await scanWorkspaceCredentials(root)).toEqual([]);
});

test("reports the file mode so a reader can tell who could open it", async () => {
  const root = await workspace();
  await writeFile(join(root, ".netrc"), "machine github.com login me password hunter22\n");

  const findings = await scanWorkspaceCredentials(root);

  expect(findings[0]?.mode).toMatch(/^-rw/);
});
