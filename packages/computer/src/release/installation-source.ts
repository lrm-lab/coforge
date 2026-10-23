import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import installSh from "../../../../scripts/release/install.sh" with { type: "text" };
import installPs1 from "../../../../scripts/release/install.ps1" with { type: "text" };

/** The install scripts' exit status for a feed that could not be reached or answered non-2xx
 * (`download_failed_status` in install.sh, `$downloadFailedStatus` in install.ps1). */
export const DOWNLOAD_FAILED_EXIT_STATUS = 75;

/** The install script reported that the feed could not be downloaded from, as opposed to having
 * downloaded something it refused. */
export class InstallationDownloadError extends Error {
  constructor(readonly status: number) {
    super(`release feed could not be reached: download failed (exit ${status})`);
    this.name = "InstallationDownloadError";
  }
}

/** Run the very same installer source shipped by Web, embedded into the native executable.
 * No mutable remote script or caller-provided feed override participates in an upgrade. */
export async function runInstallationSource(options: {
  baseUrl: string;
  target: string;
  selection: string;
  directory?: string;
  quietHeader?: boolean;
  phase?: "manifest" | "artifact" | "installer";
}): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "coforge-install-source-"));
  const windows = process.platform === "win32";
  const path = join(temporary, windows ? "install.ps1" : "install.sh");
  try {
    await writeFile(path, windows ? installPs1 : installSh, { mode: 0o600 });
    const args = windows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          // Process-local: allow our embedded script without changing the user's policy.
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path,
          "-Version",
          options.selection,
          "-Target",
          options.target,
          ...(options.directory ? ["-PrepareDirectory", options.directory] : ["-ResolveOnly"]),
        ]
      : [
          "sh",
          path,
          "--version",
          options.selection,
          "--target",
          options.target,
          ...(options.directory ? ["--prepare-directory", options.directory] : ["--resolve-only"]),
        ];
    if (options.quietHeader) args.push(windows ? "-QuietHeader" : "--quiet-header");
    if (options.phase) args.push(windows ? "-PreparePhase" : "--prepare-phase", options.phase);
    const child = Bun.spawn({
      cmd: args,
      env: {
        ...Bun.env,
        COFORGE_RELEASE_FEED_URL: options.baseUrl,
        // Production callers pass the compiled HTTPS feed. Only module fixtures pass HTTP.
        COFORGE_INSTALLER_TEST_MODE: new URL(options.baseUrl).protocol === "http:" ? "1" : "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (status === DOWNLOAD_FAILED_EXIT_STATUS) throw new InstallationDownloadError(status);
    if (status !== 0) throw new Error(`installer preparation failed (exit ${status})`);
    return output.trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
