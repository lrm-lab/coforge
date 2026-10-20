import { expect, test } from "bun:test";
import { selectChecks } from "./selection";

test("a Web-only PR does not run client or infrastructure checks", () => {
  expect(selectChecks(["apps/web/src/features/tasks/task-board.tsx"], "changes")).toEqual(["web"]);
});

test("CI policy runs when its scripts, setup, or shared inputs change", () => {
  expect(selectChecks(["scripts/ci/selection.ts"], "changes")).toContain("ci");
  expect(selectChecks([".agents/setup"], "changes")).toContain("ci");
  expect(selectChecks(["bun.lock"], "changes")).toContain("ci");
});

test("test-only client changes validate their owner without rebuilding native executables", () => {
  expect(selectChecks(["packages/daemon/test/held-publications.test.ts"], "changes")).toEqual([
    "daemon",
  ]);
  expect(selectChecks(["packages/computer/test/setup.test.ts"], "changes")).toEqual(["computer"]);
  expect(selectChecks(["packages/daemon/test/macos-supervisor.test.ts"], "changes")).toEqual([
    "daemon",
    "macos-lifecycle",
  ]);
  // The real-launchd Agent relay cases; launchd-process.test.ts keeps only portable ones.
  expect(selectChecks(["packages/daemon/test/launchd-process.integration.ts"], "changes")).toEqual([
    "daemon",
    "macos-lifecycle",
  ]);
  expect(selectChecks(["packages/daemon/test/launchd-process.test.ts"], "changes")).toEqual([
    "daemon",
  ]);
});

test("workspace manifests validate their consumers and the image that copies them", () => {
  expect(selectChecks(["apps/web/package.json"], "changes")).toEqual(["web"]);
  expect(selectChecks(["packages/computer/package.json"], "changes")).toEqual([
    "computer",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
});

test("dependency changes include downstream consumers, but not unrelated modules", () => {
  expect(selectChecks(["packages/daemon/src/runtime.ts"], "changes")).toEqual([
    "computer",
    "daemon",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["packages/coforge/src/cli.ts"], "changes")).toEqual([
    "coforge",
    "computer",
    "daemon",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["packages/agent/src/contract.ts"], "changes")).toEqual([
    "agent",
    "computer",
    "daemon",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
});

test("documentation skips application checks, while shared and unknown inputs fail open to full coverage", () => {
  expect(
    selectChecks(["README.md", "docs/release/README.md", "packages/daemon/AGENTS.md"], "changes"),
  ).toEqual([]);
  const all = [
    "agent",
    "cdn-certs",
    "ci",
    "coforge",
    "coforge-sdk",
    "computer",
    "daemon",
    "deploy",
    "installer-crate",
    "macos-lifecycle",
    "oss-cdn",
    "reference-computer",
    "release",
    "web",
    "windows-installer",
    "windows-release",
  ];
  for (const path of [
    "bun.lock",
    "mise.toml",
    "package.json",
    ".github/workflows/ci.yml",
    "packages/new/src/index.ts",
    "packages/coforge-sdk/messages.ts",
  ]) {
    expect(selectChecks([path], "changes")).toEqual(all);
  }
  expect(selectChecks(["packages/computer/src/cli.ts"], "changes")).toEqual([
    "computer",
    "macos-lifecycle",
    "windows-release",
  ]);
  // The install scripts' own behavior is exercised by packages/computer/test/installer-scripts.test.ts
  // (install.sh directly, install.ps1 under PowerShell 7), so a change to either runs Computer.
  expect(selectChecks(["scripts/release/install.ps1"], "changes")).toEqual([
    "computer",
    "release",
    "web",
    "windows-installer",
  ]);
  expect(selectChecks(["scripts/release/install.sh"], "changes")).toEqual([
    "computer",
    "release",
    "web",
  ]);
  for (const path of [
    "crates/installer/src/fetch.rs",
    "Cargo.lock",
    "Cargo.toml",
    "crates/installer/Cargo.toml",
    "crates/installer/mise.toml",
  ]) {
    expect(selectChecks([path], "changes")).toEqual(["installer-crate"]);
  }
  for (const path of [
    "crates/installer/contract/receipt.schema.json",
    "crates/installer/contract/rust/x.json",
  ]) {
    expect(selectChecks([path], "changes")).toEqual(["computer", "installer-crate"]);
  }
  expect(selectChecks(["crates/installer/AGENTS.md"], "changes")).toEqual([]);
  // The installer's tests take the Computer's machine mutation lock through this very module.
  expect(selectChecks(["packages/daemon/src/platform/process-lock.ts"], "changes")).toEqual([
    "computer",
    "daemon",
    "installer-crate",
    "macos-lifecycle",
    "windows-release",
  ]);
  expect(selectChecks(["infra/staging/caddy/Caddyfile"], "changes")).toEqual(["deploy", "web"]);
  expect(selectChecks(["scripts/ops/renew-cdn-certificates.sh"], "changes")).toEqual(["cdn-certs"]);
  expect(selectChecks(["scripts/reference-computer/extract.ts"], "changes")).toEqual([
    "reference-computer",
  ]);
  expect(selectChecks(["scripts/release/compile-targets.ts"], "changes")).toEqual([
    "computer",
    "daemon",
    "macos-lifecycle",
    "release",
    "windows-release",
  ]);
});

test("deployment validates the exact Web track only when the image or deployment is affected", () => {
  for (const path of [
    "docs/release/README.md",
    "packages/daemon/src/runtime.ts",
    "scripts/release/publish.ts",
  ]) {
    expect(selectChecks([path], "web")).toEqual([]);
  }
  for (const path of [
    "apps/web/src/index.ts",
    "scripts/release/install.ps1",
    "packages/agent/src/contract.ts",
  ]) {
    expect(selectChecks([path], "web")).toEqual(["deploy", "coforge-sdk", "web"]);
  }
  expect(selectChecks(["bun.lock"], "web")).toEqual(["ci", "deploy", "coforge-sdk", "web"]);
});

test("manual local publication always validates its complete track, regardless of changed files, without the separately released installer crate", () => {
  expect(selectChecks([], "local")).toEqual([
    "agent",
    "ci",
    "coforge",
    "coforge-sdk",
    "computer",
    "daemon",
    "macos-lifecycle",
    "release",
    "windows-installer",
    "windows-release",
  ]);
});

test("manual installer publication validates the installer crate and only the installer crate, regardless of changed files", async () => {
  expect(selectChecks([], "installer")).toEqual(["installer-crate"]);
  expect(
    selectChecks(["apps/web/src/a.tsx", "packages/daemon/src/runtime.ts"], "installer"),
  ).toEqual(["installer-crate"]);
  const child = Bun.spawn([process.execPath, "scripts/ci/selection.ts", "installer"], {
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('checks=["installer-crate"]\n');
  expect(output).toContain('jobs=["changes","installer-crate"]\n');
  expect(output).toContain("deploy=false\n");
});

test("workflow selection accepts NUL-delimited filenames and emits job and matrix outputs", async () => {
  const child = Bun.spawn([process.execPath, "scripts/ci/selection.ts", "changes"], {
    stdin: new Blob(["apps/web/src/a\npage.tsx\0packages/coforge/src/cli.ts\0"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('libraries=["coforge"]\n');
  expect(output).toContain("contracts=[]\n");
  expect(output).toContain(
    'jobs=["changes","libraries","computer","daemon","macos-lifecycle","web","windows-release"]\n',
  );
});
