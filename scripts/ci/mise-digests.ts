#!/usr/bin/env bun
// Regenerates .github/mise-digests.env for a mise release (task #714).
//
//   bun scripts/ci/mise-digests.ts [version]        # default: keep MISE_VERSION
//
// Binary hashes come from the release's SHASUMS256.txt: the `mise` executable
// inside each archive is byte-identical to the raw `mise-v<ver>-<target>`
// asset, so its hash is the SHASUMS entry for that asset. Shim hashes only
// exist inside the Windows .zip archives and are computed by extraction.
//
// BUN_* values come from mise.lock instead: each platform's bun zip is
// downloaded from the URL the lock records, its sha256 checked against the
// lock's checksum, and the `bun`/`bun.exe` binary inside is hashed. The zip
// ships a single binary at top level; mise builds the bin/ + bunx layout
// itself on install.

import { createHash, createPublicKey, verify } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const OUT = `${ROOT}.github/mise-digests.env`;

const TARGETS = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["macos", "x64"],
  ["macos", "arm64"],
  ["windows", "x64"],
  ["windows", "arm64"],
] as const;

// mise.lock platform key -> digest-file key suffix.
const BUN_PLATFORMS = {
  "linux-x64": "LINUX_X64",
  "linux-arm64": "LINUX_ARM64",
  "macos-x64": "MACOS_X64",
  "macos-arm64": "MACOS_ARM64",
  "windows-x64": "WINDOWS_X64",
  "windows-arm64": "WINDOWS_ARM64",
} as const;

const current = await Bun.file(OUT).text();
const version = process.argv[2] ?? current.match(/^MISE_VERSION=(\S+)/m)?.[1];
if (!version) throw new Error("no version argument and no MISE_VERSION in digests");

const base = `https://github.com/jdx/mise/releases/download/v${version}`;
const fetchRetry = async (url: string) => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(`download failed: ${url}`);
};
const shasums = await (await fetchRetry(`${base}/SHASUMS256.txt`)).text();

// The digest file is the trust root for every credential job, so its hashes
// must come from a SHASUMS256.txt carrying jdx's minisign signature — the same
// check jdx/mise-action performs — not merely from an HTTPS download. Ported
// from that action's verifyMinisign.
const MISE_MINISIGN_PUBLIC_KEY = "RWTC3g8W3z4RZK3V3qv7fa1QY4JEWyBtqIHW+85QlJpZc5yG+uNYNBSZ";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const verifyMinisign = (data: string, minisig: string) => {
  const lines = minisig.trimEnd().split(/\r?\n/);
  if (lines.length < 4) throw new Error("invalid minisign signature");
  const publicKeyBytes = Buffer.from(MISE_MINISIGN_PUBLIC_KEY, "base64");
  const signatureBytes = Buffer.from(lines[1]!, "base64");
  const trustedSignatureBytes = Buffer.from(lines[3]!, "base64");
  if (
    publicKeyBytes.length !== 42 ||
    signatureBytes.length !== 74 ||
    trustedSignatureBytes.length !== 64
  ) {
    throw new Error("invalid minisign signature format");
  }
  if (!publicKeyBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10))) {
    throw new Error("minisign key id mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const dataDigest = createHash("blake2b512").update(data).digest();
  const dataSignature = signatureBytes.subarray(10);
  if (!verify(null, dataDigest, publicKey, dataSignature)) {
    throw new Error("invalid SHASUMS256.txt minisign signature");
  }
  const trustedComment = lines[2]!.replace(/^trusted comment: /, "");
  const trustedCommentData = Buffer.concat([dataSignature, Buffer.from(trustedComment)]);
  if (!verify(null, trustedCommentData, publicKey, trustedSignatureBytes)) {
    throw new Error("invalid minisign trusted comment signature");
  }
};
const predatesMinisign = (v: string) => {
  const match = v.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  return y! < 2024 || (y === 2024 && (m! < 12 || (m === 12 && d! < 24)));
};
if (predatesMinisign(version)) {
  console.warn(`mise ${version} predates minisign checksums; skipping signature check`);
} else {
  const minisig = await (await fetchRetry(`${base}/SHASUMS256.txt.minisig`)).text();
  verifyMinisign(shasums, minisig);
}

const assetHash = (name: string) => {
  const line = shasums
    .split("\n")
    .find((l) => l.trimEnd().endsWith(`  ./${name}`) || l.trimEnd().endsWith(` ${name}`));
  const hash = line?.trimStart().slice(0, 64);
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`no sha256 for ${name}`);
  return hash;
};

const sha256 = async (buf: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// The shim ships only inside the Windows zip; stream it out without a full extract.
const shimHash = async (target: string) => {
  const zip = `${base}/mise-v${version}-${target}.zip`;
  const tmp = `${process.env.TMPDIR ?? "/tmp"}mise-v${version}-${target}.zip`;
  const response = await fetchRetry(zip);
  if (!response.body) throw new Error(`download failed: ${zip}`);
  await Bun.write(tmp, response.body);
  const out = Bun.spawnSync(["unzip", "-p", tmp, "mise/bin/mise-shim.exe"], {
    stdout: "pipe",
  });
  rmSync(tmp, { force: true });
  if (out.exitCode !== 0) throw new Error(`unzip failed for ${target}`);
  return sha256(out.stdout);
};

// bun's version and per-platform zip URL+checksum live in mise.lock, which
// the repository already trusts: verify the downloaded zip against the lock's
// checksum, then hash the single binary inside it.
const lock = await Bun.file(`${ROOT}mise.lock`).text();
const bunSection = lock.match(/\[\[tools\.bun\]\]([\s\S]*?)(?=\n\[\[tools\.|$)/)?.[1];
const bunVersion = bunSection?.match(/^version = "([^"]+)"/m)?.[1];
if (!bunSection || !bunVersion) throw new Error("no [[tools.bun]] version in mise.lock");

const bunBinaryHash = async (platform: string, key: string) => {
  const entry = bunSection.match(
    new RegExp(
      `platforms\\.${platform}"\\]\\s*\\nchecksum = "sha256:([0-9a-f]{64})"\\s*\\nurl = "([^"]+)"`,
    ),
  );
  const [, wantZip, url] = entry ?? [];
  if (!wantZip || !url) throw new Error(`no mise.lock entry for bun ${platform}`);
  const tmp = `${process.env.TMPDIR ?? "/tmp"}bun-${platform}.zip`;
  const response = await fetchRetry(url);
  if (!response.body) throw new Error(`download failed: ${url}`);
  await Bun.write(tmp, response.body);
  const zipHash = await sha256(new Uint8Array(await Bun.file(tmp).arrayBuffer()));
  if (zipHash !== wantZip) {
    rmSync(tmp, { force: true });
    throw new Error(`bun ${platform} zip sha256 does not match mise.lock`);
  }
  const asset = url
    .split("/")
    .pop()!
    .replace(/\.zip$/, "");
  const member = platform.startsWith("windows") ? `${asset}/bun.exe` : `${asset}/bun`;
  const out = Bun.spawnSync(["unzip", "-p", tmp, member], { stdout: "pipe" });
  rmSync(tmp, { force: true });
  if (out.exitCode !== 0) throw new Error(`unzip failed for ${member}`);
  return [`BUN_SHA256_${key}`, await sha256(out.stdout)] as const;
};

const lines = [
  "# mise binary digests for the credential-bearing workflow jobs (task #714).",
  "#",
  "# MISE_VERSION is the single version pin read by",
  "# scripts/ci/workflow-mise-cache.test.ts, which fails if any workflow's",
  "# `version:` input drifts from it. Bump the version here and in every",
  "# workflow `version:` input together, then regenerate the SHA256_* values",
  "# with:",
  "#",
  "#   bun scripts/ci/mise-digests.ts",
  "#",
  "# SHA256_<OS>_<ARCH> is the sha256 of the `mise` executable the runner",
  "# installs for that target — the same bytes as the raw release asset",
  "# `mise-v<version>-<target>[.exe]`, whose hash is published in the release's",
  "# minisign-verified SHASUMS256.txt. SHA256_<OS>_<ARCH>_SHIM covers `mise-shim.exe`,",
  "# which only the Windows archives ship.",
  "#",
  "# BUN_VERSION mirrors the `bun` pin in mise.toml/mise.lock and",
  "# BUN_SHA256_<OS>_<ARCH> is the sha256 of the `bun`/`bun.exe` binary inside",
  "# that release's zip for the target — each zip is checked against the",
  "# sha256 mise.lock records for it before the binary is hashed.",
  `MISE_VERSION=${version}`,
];
for (const [os, arch] of TARGETS) {
  const target = `${os}-${arch}`;
  const asset = os === "windows" ? `mise-v${version}-${target}.exe` : `mise-v${version}-${target}`;
  lines.push(`SHA256_${os.toUpperCase()}_${arch.toUpperCase()}=${assetHash(asset)}`);
  if (os === "windows") {
    lines.push(`SHA256_${os.toUpperCase()}_${arch.toUpperCase()}_SHIM=${await shimHash(target)}`);
  }
}
lines.push(`BUN_VERSION=${bunVersion}`);
for (const [platform, key] of Object.entries(BUN_PLATFORMS)) {
  const [name, hash] = await bunBinaryHash(platform, key);
  lines.push(`${name}=${hash}`);
}
writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`wrote ${OUT} for mise ${version}, bun ${bunVersion}`);
