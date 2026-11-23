import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";

/** Durable, non-secret configuration for one supervised Workspace connection. */
export class DaemonConfigStore {
  readonly #path: string;
  readonly #serverHttpUrl: string | undefined;
  constructor(stateDirectory: string, defaults: { serverHttpUrl?: string } = {}) {
    this.#path = join(stateDirectory, "config.json");
    this.#serverHttpUrl = defaults.serverHttpUrl;
  }
  async load(): Promise<DaemonConfig | null> {
    try {
      const persisted = JSON.parse(await Bun.file(this.#path).text()) as DaemonConfig;
      const config = {
        ...persisted,
        workspaceRoot: reachableWorkspaceRoot(persisted.workspaceRoot),
      };
      if (!this.#serverHttpUrl) return config;
      if (!config.serverHttpUrl) {
        throw new Error("Persisted daemon configuration does not identify its server");
      }
      return this.bindToServer(config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(config: DaemonConfig): Promise<void> {
    await this.#write(this.bindToServer(config));
  }
  assertExpectedServer(expectedServerUrl: string): void {
    if (
      !this.#serverHttpUrl ||
      !expectedServerUrl ||
      new URL(expectedServerUrl).origin !== new URL(this.#serverHttpUrl).origin
    ) {
      throw new Error("Daemon request server does not match this daemon build");
    }
  }
  bindToServer(config: DaemonConfig): DaemonConfig {
    if (
      this.#serverHttpUrl &&
      config.serverHttpUrl &&
      new URL(config.serverHttpUrl).origin !== new URL(this.#serverHttpUrl).origin
    ) {
      throw new Error("Daemon configuration server does not match this daemon build");
    }
    return this.#serverHttpUrl ? { ...config, serverHttpUrl: this.#serverHttpUrl } : config;
  }
  async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
  async #write(config: DaemonConfig): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}

/** The binding names the state mount as the launcher sees it (`/root/.coforge/...`). A Workspace
 * daemon that runs as its own uid cannot traverse `/root`, so when the container also mounts the
 * volume where that uid can reach it, the same tree is addressed through that path instead. */
export function reachableWorkspaceRoot(
  workspaceRoot: string,
  volumeRoot: string | undefined = process.env.COFORGE_WORKSPACE_VOLUME_ROOT,
): string {
  const legacy = "/root/.coforge";
  if (!volumeRoot || volumeRoot === legacy) return workspaceRoot;
  if (workspaceRoot === legacy) return volumeRoot;
  return workspaceRoot.startsWith(`${legacy}/`)
    ? `${volumeRoot}${workspaceRoot.slice(legacy.length)}`
    : workspaceRoot;
}
