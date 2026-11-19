import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM_BINARIES = ["xdg-open", "open", "browser-shim"] as const;
const CAPTURE_FILENAME = "captured-urls.txt";

export interface AntigravityBrowserShim {
  readonly active: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readCapturedUrls(): Promise<string[]>;
  dispose(): Promise<void>;
}

export function noopAntigravityBrowserShim(
  baseEnvironment: Readonly<Record<string, string>>,
): AntigravityBrowserShim {
  return {
    active: false,
    environment: baseEnvironment,
    readCapturedUrls: async () => [],
    dispose: async () => undefined,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function browserShimScript(captureFile: string): string {
  const target = shellQuote(captureFile);
  return [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    http://*|https://*)",
    `      printf '%s\\n' "$arg" >> ${target}`,
    "      ;;",
    "  esac",
    "done",
    "exit 0",
    "",
  ].join("\n");
}

export async function createAntigravityBrowserShim(
  baseEnvironment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Promise<AntigravityBrowserShim> {
  if (platform === "win32") return noopAntigravityBrowserShim(baseEnvironment);
  const directory = await mkdtemp(join(tmpdir(), "coforge-agy-browser-"));
  try {
    await chmod(directory, 0o700);
    const captureFile = join(directory, CAPTURE_FILENAME);
    const script = browserShimScript(captureFile);
    await Promise.all(
      SHIM_BINARIES.map(async (name) => {
        const scriptPath = join(directory, name);
        await writeFile(scriptPath, script, { mode: 0o700 });
        await chmod(scriptPath, 0o700);
      }),
    );
    const existingPath = baseEnvironment.PATH;
    const environment: Readonly<Record<string, string>> = {
      ...baseEnvironment,
      PATH: existingPath ? `${directory}:${existingPath}` : directory,
      BROWSER: join(directory, "browser-shim"),
    };
    let disposed = false;
    return {
      active: true,
      environment,
      readCapturedUrls: async () => {
        if (disposed) return [];
        try {
          const content = await readFile(captureFile, "utf8");
          if (disposed) return [];
          const lines = content.split(/\r?\n/u);
          if (!content.endsWith("\n")) lines.pop();
          return lines.map((line) => line.trim()).filter((line) => line.length > 0);
        } catch {
          return [];
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
