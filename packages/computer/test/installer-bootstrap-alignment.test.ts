import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run, serveStub, servers, temporaryDirectories } from "./installer-script-runner";

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const target = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installerPath = `/installer/0.1.0/${target}/coforge-installer.gz`;

function checksum(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<{ baseUrl: string; log: string; requested: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-bootstrap-alignment-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const installer = Buffer.from(`#!/bin/sh
printf 'installer:' >> "$COFORGE_BOOTSTRAP_LOG"
printf ' %s' "$@" >> "$COFORGE_BOOTSTRAP_LOG"
printf '\\n' >> "$COFORGE_BOOTSTRAP_LOG"
if [ "$1" = install ] || [ "$1" = upgrade ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/coforge-computer" <<'EOF'
#!/bin/sh
printf 'setup:' >> "$COFORGE_BOOTSTRAP_LOG"
printf ' %s' "$@" >> "$COFORGE_BOOTSTRAP_LOG"
printf '\\n' >> "$COFORGE_BOOTSTRAP_LOG"
EOF
  chmod 700 "$HOME/.local/bin/coforge-computer"
fi
if [ "$1" = repair ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/coforge-computer" <<'EOF'
#!/bin/sh
printf 'setup:' >> "$COFORGE_BOOTSTRAP_LOG"
printf ' %s' "$@" >> "$COFORGE_BOOTSTRAP_LOG"
printf '\\n' >> "$COFORGE_BOOTSTRAP_LOG"
EOF
  chmod 700 "$HOME/.local/bin/coforge-computer"
fi
exit 0
`);
  const files = new Map<string, Uint8Array>([
    ["/installer/latest", Buffer.from("0.1.0\n")],
    [installerPath, Bun.gzipSync(installer)],
    [`/installer/0.1.0/${target}/coforge-installer.sha256`, Buffer.from(`${checksum(installer)}\n`)],
  ]);
  const requested: string[] = [];
  const server = serveStub({
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const body = files.get(path);
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, log, requested };
}

test("the version pin wins over the default channel", async () => {
  const served = await fixture();
  const child = await run(["install"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    RAFT_COMPUTER_VERSION: "2026.10.24",
    INSTALL_CHANNEL_DEFAULT: "beta",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(served.log, "utf8")).trim()).toBe(
    "installer: install --version 2026.10.24",
  );
});

test("a channel pin is forwarded without a conflicting latest version", async () => {
  const served = await fixture();
  const child = await run(["install"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    INSTALL_CHANNEL_DEFAULT: "main",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(served.log, "utf8")).trim()).toBe("installer: install --channel main");
});

test("explicit repair version and channel override the environment pins", async () => {
  const served = await fixture();
  const child = await run(["repair", "--version", "2026.10.20"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    RAFT_COMPUTER_VERSION: "2026.10.24",
    INSTALL_CHANNEL_DEFAULT: "beta",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(served.log, "utf8")).trim()).toBe(
    "installer: repair --version 2026.10.20",
  );
});

test("repair forwards native confirmation and downgrade flags", async () => {
  const served = await fixture();
  const child = await run(["repair", "--yes", "--allow-downgrade"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(served.log, "utf8")).trim()).toBe(
    "installer: repair --yes --allow-downgrade",
  );
});

test("--setup forwards all trailing arguments to the installed Computer", async () => {
  const served = await fixture();
  const child = await run(["install", "--setup", "--workspace", "demo"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(served.log, "utf8")).trim().split("\n")).toEqual([
    "installer: install --version latest",
    "setup: setup --workspace demo",
  ]);
});

test("--setup requires a setup argument", async () => {
  const served = await fixture();
  const child = await run(["install", "--setup"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: served.baseUrl,
    COFORGE_INSTALLER_TEST_MODE: "1",
    COFORGE_BOOTSTRAP_LOG: served.log,
  });
  expect(child.exitCode).toBe(2);
});

test("--setup runs against an existing Computer after a retryable installer failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-bootstrap-setup-retry-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const installer = Buffer.from(`#!/bin/sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/coforge-computer" <<'EOF'
#!/bin/sh
printf 'setup: %s %s\\n' "$1" "$3" >> "$COFORGE_BOOTSTRAP_LOG"
EOF
chmod 700 "$HOME/.local/bin/coforge-computer"
printf '%s\\n' "$@" >> "${log}"
exit 3
`);
  const server = serveStub({
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/installer/latest") return new Response("0.1.0\n");
      if (path === installerPath) return new Response(Bun.gzipSync(installer));
      if (path.endsWith("coforge-installer.sha256")) return new Response(`${checksum(installer)}\n`);
      return new Response("not found", { status: 404 });
    },
  });
  const child = await run(["repair", "--setup", "--workspace", "demo"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: `http://127.0.0.1:${server.port}`,
    COFORGE_INSTALLER_TEST_MODE: "1",
    COFORGE_BOOTSTRAP_LOG: log,
  });
  expect(child.exitCode).toBe(0);
  expect((await readFile(log, "utf8")).trim().split("\n").slice(-1)[0]).toBe("setup: setup demo");
});

test("help is forwarded and does not retry an exit-3 installer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-bootstrap-help-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const installer = Buffer.from(`#!/bin/sh
printf '%s\\n' "$@" >> "${log}"
exit 3
`);
  const server = serveStub({
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/installer/latest") return new Response("0.1.0\n");
      if (path === installerPath) return new Response(Bun.gzipSync(installer));
      if (path.endsWith("coforge-installer.sha256")) return new Response(`${checksum(installer)}\n`);
      return new Response("not found", { status: 404 });
    },
  });
  const child = await run(["help"], {
    ...process.env,
    COFORGE_RELEASE_FEED_URL: `http://127.0.0.1:${server.port}`,
    COFORGE_INSTALLER_TEST_MODE: "1",
  });
  expect(child.exitCode).toBe(3);
  expect((await readFile(log, "utf8")).trim()).toBe("help");
});

test("install.ps1 exposes the same bootstrap command and pin contract", async () => {
  const script = await readFile(
    resolve(import.meta.dir, "../../../scripts/release/install.ps1"),
    "utf8",
  );
  expect(script).toContain(
    '[ValidateSet("install", "upgrade", "repair", "status", "recover", "help")]',
  );
  expect(script).toContain("RAFT_COMPUTER_VERSION");
  expect(script).toContain("INSTALL_CHANNEL_DEFAULT");
  expect(script).toContain("$Setup");
  expect(script).toContain("$Command");
  expect(script).toContain('"--channel"');
});
