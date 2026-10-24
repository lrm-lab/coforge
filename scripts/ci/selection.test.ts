import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { crossPackageScans, selectChecks } from "./selection";

test("a Web-only PR does not run client or infrastructure checks", () => {
  // coforge-sdk's RuntimeProvider literal scan reads apps/web/src too.
  expect(selectChecks(["apps/web/src/features/tasks/task-board.tsx"], "changes")).toEqual([
    "coforge-sdk",
    "web",
  ]);
  expect(selectChecks(["apps/web/test/a.test.ts"], "changes")).toEqual(["web"]);
});

test("a change a cross-package scan test reads runs the check that owns the scan", () => {
  expect(
    selectChecks(["packages/daemon/src/code-agent/runtime-executable.ts"], "changes"),
  ).toContain("coforge-sdk");
  expect(selectChecks(["apps/web/src/routes/index.tsx"], "changes")).toContain("coforge-sdk");
  expect(selectChecks(["packages/computer/src/cli.ts"], "changes")).toContain("web");
  // The literal scan skips test and generated files.
  for (const path of [
    "packages/daemon/test/foo.test.ts",
    "packages/daemon/src/foo.test.ts",
    "packages/computer/src/gen/a.ts",
    "packages/computer/src/a.gen.ts",
  ]) {
    expect(selectChecks([path], "changes")).not.toContain("coforge-sdk");
  }
  // The import-alias scan reads only .ts files.
  expect(selectChecks(["packages/computer/src/a.tsx"], "changes")).not.toContain("web");
  // The Web track deploys only for the image's inputs; a scan adds nothing there.
  expect(selectChecks(["packages/computer/src/cli.ts"], "web")).toEqual([]);
  expect(selectChecks(["packages/daemon/test/foo.test.ts"], "web")).toEqual([]);
});

test("every cross-package scan test exists, so moving one breaks CI", () => {
  expect(crossPackageScans.length).toBeGreaterThan(0);
  for (const { test: file } of crossPackageScans) {
    expect(existsSync(join(import.meta.dir, "..", "..", file)), file).toBe(true);
  }
});

test("CI policy runs when its scripts, setup, or shared inputs change", () => {
  expect(selectChecks(["scripts/ci/selection.ts"], "changes")).toContain("ci");
  expect(selectChecks([".agents/setup"], "changes")).toContain("ci");
  expect(selectChecks(["bun.lock"], "changes")).toContain("ci");
});

test("test-only client changes validate their owner without rebuilding native executables", () => {
  // Web's import-alias scan reads packages' test files too, so each also runs Web.
  expect(selectChecks(["packages/daemon/test/held-publications.test.ts"], "changes")).toEqual([
    "daemon",
    "web",
  ]);
  expect(selectChecks(["packages/computer/test/setup.test.ts"], "changes")).toEqual([
    "computer",
    "web",
  ]);
  expect(selectChecks(["packages/daemon/test/macos-supervisor.test.ts"], "changes")).toEqual([
    "daemon",
    "macos-lifecycle",
    "web",
  ]);
  // The real-launchd Agent relay cases; launchd-process.test.ts keeps only portable ones.
  expect(selectChecks(["packages/daemon/test/launchd-process.integration.ts"], "changes")).toEqual([
    "daemon",
    "macos-lifecycle",
    "web",
  ]);
  expect(selectChecks(["packages/daemon/test/launchd-process.test.ts"], "changes")).toEqual([
    "daemon",
    "web",
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
    "coforge-sdk",
    "computer",
    "daemon",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
  expect(selectChecks(["packages/coforge/src/cli.ts"], "changes")).toEqual([
    "coforge",
    "coforge-sdk",
    "computer",
    "daemon",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
  expect(selectChecks(["packages/agent/src/contract.ts"], "changes")).toEqual([
    "agent",
    "coforge-sdk",
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
    "anvil",
    "cdn-certs",
    "ci",
    "coforge",
    "coforge-sdk",
    "computer",
    "daemon",
    "deploy",
    "docs-site",
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
    "coforge-sdk",
    "computer",
    "macos-lifecycle",
    "web",
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
    "coforge-sdk",
    "computer",
    "daemon",
    "installer-crate",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
  expect(selectChecks(["infra/staging/caddy/Caddyfile"], "changes")).toEqual(["deploy", "web"]);
  expect(selectChecks(["scripts/ops/renew-cdn-certificates.ts"], "changes")).toEqual(["cdn-certs"]);
  expect(selectChecks(["scripts/docs/publish-docs-site.ts"], "changes")).toEqual(["docs-site"]);
  expect(selectChecks([".github/workflows/docs-production.yml"], "changes")).toEqual([
    "ci",
    "docs-site",
  ]);
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

test("benchmark changes run the Web job, which checks and tests the benchmarks, and deploy nothing", async () => {
  // The benchmarks import Web source and its generated client, so the Web job checks them after
  // Web's own checks; they are not in the image, so the Web track does not select them.
  for (const path of ["benchmark/skillsbench-collab/src/verify.ts", "benchmark/x/package.json"]) {
    expect(selectChecks([path], "changes")).toEqual(["web"]);
    expect(selectChecks([path], "web")).toEqual([]);
  }
  const ci = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text());
  const steps = ci.jobs.web.steps.map((step: { run?: string }) => step.run);
  const web = steps.indexOf("mise run check:web");
  const benchmarks = steps.indexOf(
    "bun run --filter './benchmark/*' check && bun run --filter './benchmark/*' --if-present test",
  );
  expect(web).toBeGreaterThan(-1);
  expect(benchmarks).toBeGreaterThan(web);
  expect(ci.jobs.web.steps[benchmarks].if).toBe("inputs.track != 'web'");
});

test("Daemon and CLI changes run the Web job, whose tests and benchmarks import them, and deploy nothing", () => {
  // apps/web/bunfig.toml preloads a Daemon test helper; Web tests and benchmarks import its source.
  expect(selectChecks(["packages/daemon/index.ts"], "changes")).toContain("web");
  expect(selectChecks(["packages/daemon/test/cli-temp-state.preload.ts"], "changes")).toContain(
    "web",
  );
  // The image has no Daemon, so a Daemon change selects no Web deployment.
  expect(selectChecks(["packages/daemon/index.ts"], "web")).toEqual([]);
  // Web's type check compiles CLI source through test/fixtures/channel-thread-e2e-runtime.ts.
  expect(selectChecks(["packages/coforge/src/local-client.ts"], "changes")).toContain("web");
  expect(selectChecks(["packages/coforge/src/local-client.ts"], "web")).toEqual([]);
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
    "anvil",
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
    stdin: new Blob([
      "apps/web/src/a\npage.tsx\0packages/coforge/src/cli.ts\0packages/anvil/src/index.ts\0",
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('libraries=["anvil","coforge","coforge-sdk"]\n');
  expect(output).toContain("contracts=[]\n");
  expect(output).toContain(
    'jobs=["changes","libraries","computer","daemon","macos-lifecycle","web","windows-release"]\n',
  );
});

test("Anvil source changes validate every product consumer", () => {
  expect(selectChecks(["packages/anvil/src/contract.ts"], "changes")).toEqual([
    "anvil",
    "coforge-sdk",
    "computer",
    "daemon",
    "macos-lifecycle",
    "web",
    "windows-release",
  ]);
});
