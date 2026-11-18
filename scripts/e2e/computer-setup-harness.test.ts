import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// This suite is the e2e harness's contract test: it pins the shell files' shape (paths, ports,
// ordering, RPC names) without running them. It is named by `test:ci` (package.json), so CI's
// "Test CI policy" step runs it on every change — it cannot silently go stale again.

const harness = await readFile(new URL("./run-computer-setup.sh", import.meta.url), "utf8");
const fixtureBuild = await readFile(
  new URL("./build-computer-fixture.ts", import.meta.url),
  "utf8",
);
const waitForOnline = await readFile(new URL("./wait-for-online.sh", import.meta.url), "utf8");
const e2eInfra = await readFile(new URL("./start-e2e-infra.sh", import.meta.url), "utf8");
const e2eWeb = await readFile(new URL("./start-e2e-web.sh", import.meta.url), "utf8");

test("Computer setup harness exercises the compiled CLI and real daemon path", () => {
  expect(harness).toContain(".artifacts/e2e/native-package");
  expect(harness).not.toContain("__install-local");
  // The installer is built from this checkout, then installs the local package before setup runs.
  expect(harness.indexOf("cargo build --locked --release")).toBeGreaterThan(-1);
  expect(harness).toContain('coforge-installer" install --version "$version" --from-directory');
  // The local build may be older than the installed Computer, so it names the downgrade it means.
  expect(harness).toContain('--from-directory "$root/.artifacts/e2e/native-package" --allow-downgrade');
  expect(harness.indexOf("cargo build --locked --release")).toBeLessThan(
    harness.indexOf("--from-directory"),
  );
  expect(harness.indexOf("--from-directory")).toBeLessThan(harness.indexOf("setup --workspace"));
  expect(harness).not.toContain("dist/coforge-daemon");
  expect(harness).not.toContain("COFORGE_E2E_DAEMON_EXECUTABLE");
  expect(harness).not.toContain("COFORGE_E2E_ALLOW_DEVICE_AUTH=1");
  expect(harness).not.toContain("export HOME=");
  expect(harness).toContain("systemctl --user");
  expect(harness).not.toContain("setup --server");
  expect(fixtureBuild).toContain("COFORGE_E2E_WEB_URL");
  expect(fixtureBuild).toContain("COFORGE_E2E_CENTRIFUGO_ENDPOINT");
  expect(fixtureBuild).toContain("COFORGE_SERVER_URL");
  expect(fixtureBuild).toContain("COFORGE_DAEMON_SERVER_URL");
  expect(harness).toContain("computer:v1:register");
  expect(harness).toContain(".coforge/computer/install/active/coforge-computer");
  expect(harness).not.toContain("InMemoryDaemon");
  expect(harness).not.toContain("TRUNCATE");
});

test("Computer setup follows the localized computers redirect while waiting for Online", () => {
  expect(waitForOnline).toContain("--location");
});

test("Computer setup infrastructure keeps the normal fixed Centrifugo port", () => {
  expect(e2eInfra).not.toContain("CENTRIFUGO_PORT");
});

test("the E2E Web seeds the fixed development user after database migration", () => {
  const migration = e2eWeb.indexOf("db:migrate:deploy");
  const seed = e2eWeb.indexOf("seed-dev-data.ts");

  expect(migration).toBeGreaterThan(-1);
  expect(seed).toBeGreaterThan(migration);
});

test("the E2E Web loads the stable local Web Push key pair", () => {
  expect(e2eWeb).toContain("COFORGE_WEB_PUSH_PUBLIC_KEY");
  expect(e2eWeb).toContain("COFORGE_WEB_PUSH_PRIVATE_KEY_FILE");
});
