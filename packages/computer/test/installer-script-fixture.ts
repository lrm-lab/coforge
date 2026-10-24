import { serveStub } from "./installer-script-runner";

function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Mirrors install.sh's own `uname -s`-`uname -m` switch, so the fixture serves the exact
 * target path the script under test will request. */
export function currentTarget(): string {
  const system = Bun.spawnSync({ cmd: ["uname", "-s"] })
    .stdout.toString()
    .trim();
  const machine = Bun.spawnSync({ cmd: ["uname", "-m"] })
    .stdout.toString()
    .trim();
  const targets: Record<string, string> = {
    "Linux-x86_64": "linux-x64",
    "Linux-aarch64": "linux-arm64",
    "Linux-arm64": "linux-arm64",
    "Darwin-x86_64": "darwin-x64",
    "Darwin-arm64": "darwin-arm64",
  };
  const target = targets[`${system}-${machine}`];
  if (!target) throw new Error(`unsupported test platform: ${system}-${machine}`);
  return target;
}

/** The objects the bootstrap path requests, in order, for the fixture's installer version 0.1.0. */
export function bootstrapRequests(target: string): string[] {
  return [
    "/installer/latest",
    `/installer/0.1.0/${target}/coforge-installer.gz`,
    `/installer/0.1.0/${target}/coforge-installer.sha256`,
  ];
}

/** The fake `coforge-installer`: it records its arguments, then (like the real installer) leaves an
 * executable shim where packages/computer/src/paths.ts resolves it. It refuses any invocation other
 * than `install --version <v>`, so a bootstrap that passes the wrong arguments fails loudly. */
function fakeInstaller(
  log: string,
  options: {
    omitShim?: boolean;
    installerExitStatus?: number;
    expectedCommand?: "install" | "repair" | "status" | "recover";
    appendArgumentLog?: boolean;
    shimArgumentLog?: string;
    shimExitStatus?: number;
  },
) {
  const expectedCommand = options.expectedCommand ?? "install";
  const shim =
    (options.shimArgumentLog ? `printf '%s\\n' "$@" > '${options.shimArgumentLog}'\n` : "") +
    `exit ${options.shimExitStatus ?? 0}\n`;
  return Buffer.from(
    `#!/bin/sh\n` +
      `case "$1" in\n` +
      `  install) [ "$#" -eq 3 ] && [ "$2" = --version ] || exit 90 ;;\n` +
      `  repair|status|recover) [ "$#" -eq 1 ] || exit 90 ;;\n` +
      `  *) exit 90 ;;\n` +
      `esac\n` +
      `[ "$1" = ${expectedCommand} ] || exit 91\n` +
      `printf '%s\\n' "$@" ${options.appendArgumentLog ? ">>" : ">"} "${log}"\n` +
      (options.installerExitStatus ? `exit ${options.installerExitStatus}\n` : "") +
      (options.omitShim
        ? ""
        : `bin_directory=\${XDG_BIN_HOME:-}\n` +
          `case "$bin_directory" in\n  /*) ;;\n  *) bin_directory="$HOME/.local/bin" ;;\nesac\n` +
          `mkdir -p "$bin_directory"\n` +
          `cat > "$bin_directory/coforge-computer" <<'SHIM'\n#!/bin/sh\n${shim}SHIM\n` +
          `chmod 755 "$bin_directory/coforge-computer"\n`),
  );
}

/** Serves the Computer objects the --prepare-directory and --resolve-only calls read, and the installer
 * feed the default bootstrap reads: `installer/latest`, one installer gzip for the target and its sidecar. */
export async function serveFixture(
  options: {
    version?: string;
    installerVersion?: string;
    target?: string;
    argumentLog?: string;
    objects?: Record<string, Uint8Array>;
    corruptGzip?: boolean;
    installerLatestContent?: string;
    omitInstaller?: boolean;
    installerGzipStatus?: number;
    corruptInstallerGzip?: boolean;
    omitInstallerSidecar?: boolean;
    tamperInstallerChecksum?: boolean;
    installerExitStatus?: number;
    omitShim?: boolean;
    expectedCommand?: "install" | "repair" | "status" | "recover";
    appendArgumentLog?: boolean;
    shimArgumentLog?: string;
    shimExitStatus?: number;
    redirectPaths?: string[];
  } = {},
) {
  const version = options.version ?? "3.2.1";
  const installerVersion = options.installerVersion ?? "0.1.0";
  const target = options.target ?? currentTarget();
  const log = options.argumentLog ?? "/dev/null";
  const installer = fakeInstaller(log, options);
  const installerGzipName = target.startsWith("windows-")
    ? "coforge-installer.exe.gz"
    : "coforge-installer.gz";
  const installerRoot = `/installer/${installerVersion}/${target}`;
  const installerChecksum = options.tamperInstallerChecksum ? "0".repeat(64) : sha256hex(installer);

  const files = new Map<string, Uint8Array>([
    ["/latest", Buffer.from(`${version}\n`)],
    [`/${version}/manifest.json`, Buffer.from('{"schema_version":2}')],
    [
      `/${version}/${target}/coforge-computer.gz`,
      options.corruptGzip ? Buffer.from("not gzip") : Bun.gzipSync(Buffer.from("computer bytes")),
    ],
    [`/${version}/photon_rs_bg.wasm`, Buffer.from("#wasm-fixture\n")],
    ["/installer/latest", Buffer.from(options.installerLatestContent ?? `${installerVersion}\n`)],
  ]);
  if (!options.omitInstaller) {
    files.set(
      `${installerRoot}/${installerGzipName}`,
      options.corruptInstallerGzip ? Buffer.from("not gzip") : Bun.gzipSync(installer),
    );
  }
  if (!options.omitInstallerSidecar) {
    files.set(`${installerRoot}/coforge-installer.sha256`, Buffer.from(`${installerChecksum}\n`));
  }
  for (const [path, bytes] of Object.entries(options.objects ?? {})) files.set(path, bytes);

  const requested: string[] = [];
  const server = serveStub({
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (options.redirectPaths?.includes(path)) {
        return new Response("moved", { status: 302, headers: { Location: "/elsewhere" } });
      }
      if (path === `${installerRoot}/${installerGzipName}` && options.installerGzipStatus) {
        return new Response("failure", { status: options.installerGzipStatus });
      }
      const bytes = files.get(path);
      return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, version, target, requested };
}
