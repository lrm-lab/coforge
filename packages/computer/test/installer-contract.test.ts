import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComputerUpgradeReceipt } from "@lrm/coforge-daemon";

import { buildReleaseTree } from "../../../scripts/release/build-release";
import { CONTRACT_DIRECTORY, renderInstallerContract } from "../scripts/installer-contract";
import { ALLOWED_RECEIPTS } from "../scripts/installer-receipt-cases";
import { InstallerReceiptSchema } from "@lrm/coforge-sdk/internal/upgrade-receipt";
import {
  ActiveStateSchema,
  agentCliLauncher,
  ComputerUpdater,
  githubCliLauncher,
  InstalledIdentitySchema,
  ReleaseManifestSchema,
} from "#src/updater";

const RUST_OUTPUT = join(CONTRACT_DIRECTORY, "rust");

async function committedFiles(): Promise<string[]> {
  const entries = await readdir(CONTRACT_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coforge-installer-contract-"));
}

test("the committed installer contract is exactly what the generator renders", async () => {
  const rendered = renderInstallerContract();
  expect(await committedFiles()).toEqual([...rendered.keys()].sort());
  for (const [name, contents] of rendered) {
    expect(await readFile(join(CONTRACT_DIRECTORY, name), "utf8")).toBe(contents);
  }
});

test("the release build writes a manifest the contract schema accepts", async () => {
  const directory = await scratch();
  try {
    await buildReleaseTree(
      {
        version: "0.2.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        buildDate: "2026-09-29T00:00:00.000Z",
        artifacts: { "linux-x64": { computer: new TextEncoder().encode("computer") } },
        photonWasm: new TextEncoder().encode("wasm"),
      },
      directory,
    );
    const manifest = JSON.parse(await readFile(join(directory, "0.2.0", "manifest.json"), "utf8"));
    expect(ReleaseManifestSchema.parse(manifest).version).toBe("0.2.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the updater reads the active.json the installer writes", async () => {
  const text = await readFile(join(RUST_OUTPUT, "active.v1.json"), "utf8");
  expect(ActiveStateSchema.parse(JSON.parse(text))).toEqual({
    schema_version: 1,
    current: "0.2.0",
    previous: "0.1.0",
  });
  const installRoot = await scratch();
  try {
    await copyFile(join(RUST_OUTPUT, "active.v1.json"), join(installRoot, "active.json"));
    const updater = new ComputerUpdater({ installRoot });
    expect(await updater.getCurrentVersion()).toBe("0.2.0");
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("the installation.json the installer writes is a current installed identity", async () => {
  const identity = InstalledIdentitySchema.parse(
    JSON.parse(await readFile(join(RUST_OUTPUT, "installation.v4.json"), "utf8")),
  );
  expect(identity.schema_version).toBe(4);
});

test("the installed versions the installer writes match the product's identity schema and launchers", async () => {
  // The installer owns the version directory; this is the product's own reading of what it wrote
  // (schema, launchers, and the Computer's recorded checksum), per target.
  const installed = JSON.parse(
    await readFile(join(RUST_OUTPUT, "installed-versions.json"), "utf8"),
  );
  for (const [target, files] of Object.entries<
    Record<string, { encoding: string; content: string }>
  >(installed)) {
    const windows = target.startsWith("windows-");
    const read = (name: string): Buffer => {
      const file = files[`versions/0.2.0/${name}`];
      if (!file) throw new Error(`${target}: ${name} is missing from installed-versions.json`);
      return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
    };
    const identity = InstalledIdentitySchema.parse(
      JSON.parse(read("installation.json").toString()),
    );
    expect(identity.schema_version, target).toBe(4);
    expect(read("version").toString(), target).toBe("0.2.0\n");
    expect(read(windows ? "coforge.cmd" : "coforge").toString(), target).toBe(
      agentCliLauncher(windows),
    );
    expect(read(windows ? "gh.cmd" : "gh").toString(), target).toBe(githubCliLauncher(windows));
    const computer = read(windows ? "coforge-computer.exe" : "coforge-computer");
    expect(computer.byteLength, target).toBe(identity.computer.size);
    expect(new Bun.CryptoHasher("sha256").update(computer).digest("hex"), target).toBe(
      identity.computer.checksum,
    );
  }
});

test("the Daemon reads every receipt the installer writes", async () => {
  // The Rust crate writes one receipt per allowed row, built through its own constructor.
  const written = (await readdir(RUST_OUTPUT)).filter((name) => name.startsWith("receipt."));
  expect(written.sort()).toEqual(ALLOWED_RECEIPTS.map(({ slug }) => `receipt.${slug}.json`).sort());
  // The wire has no held status: the Daemon settles a held operation as a failed one.
  const settled = { succeeded: "succeeded", failed: "failed", held: "failed" } as const;
  for (const { slug, fields } of ALLOWED_RECEIPTS) {
    const name = `receipt.${slug}.json`;
    const receipt = InstallerReceiptSchema.parse(
      JSON.parse(await readFile(join(RUST_OUTPUT, name), "utf8")),
    );
    expect(receipt.exit_code).toBe(fields.exit_code);
    const homeDirectory = await scratch();
    try {
      const installRoot = join(homeDirectory, ".coforge", "computer", "install");
      const results = join(installRoot, "upgrade-results");
      await mkdir(results, { recursive: true });
      // Named by the receipt's own request id, whatever its case: the Daemon reads it by that id.
      await copyFile(join(RUST_OUTPUT, name), join(results, `${receipt.request_id}.result.json`));
      const read = await readComputerUpgradeReceipt(receipt.request_id, { installRoot });
      expect(read?.status).toBe(settled[fields.status]);
      expect(read?.version).toBe("version" in fields ? fields.version : undefined);
      expect(read?.error).toBe("error" in fields ? fields.error : undefined);
      expect(read?.errorCode).toBe("errorCode" in fields ? fields.errorCode : undefined);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  }
});
