import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverDshCatalog } from "@lrm/coforge-anvil/dsh";
import { RuntimeVersionUnsupportedError } from "@lrm/coforge-anvil";
import type { CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { dshRuntimeHost } from "./host";

export type DshCatalogOptions = {
  command: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  force?: boolean;
  timeoutMs?: number;
};

function nativeHome(options: DshCatalogOptions): string {
  const home = options.environment.HOME ?? options.environment.USERPROFILE ?? homedir();
  const configured = options.environment.DSH_HOME;
  let path = configured?.trim() ? configured : join(home, ".dsh");
  if (path === "~") path = home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(home, path.slice(2));
  return resolve(options.cwd, path);
}

async function snapshot(options: DshCatalogOptions) {
  const environment = dshRuntimeHost.buildEnvironment({
    agentWorkspaceDirectory: options.cwd,
    instructions: "",
    environment: options.environment,
  });
  const home = nativeHome({ ...options, environment });
  environment.DSH_HOME = home;
  const profile = join(home, "profiles", "acp");
  // rc.2 rewrites cordis.yml to a fixed [] on every boot; it is not user configuration.
  // User composition lives in package.json and cordis.patch.yml (profile-boot.js).
  const paths = [
    { path: options.command[0]!, kind: "install" },
    ...["cordis.patch.yml", ".credentials.yaml", ".env"].map((name) => ({
      path: join(home, name),
      kind: "config",
    })),
    ...["cordis.patch.yml", "package.json", "pnpm-lock.yaml"].map((name) => ({
      path: join(profile, name),
      kind: "profile",
    })),
  ];
  const profileExists = await stat(profile).then(
    (info) => info.isDirectory(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const files = await Promise.all(
    paths.map(async (file) => {
      try {
        const info = await stat(file.path);
        return {
          ...file,
          stamp: JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { ...file, stamp: "missing" };
        throw error;
      }
    }),
  );
  // Config expressions may read arbitrary environment variables. This fingerprint never leaves
  // memory, so a disk catalog cannot be validated after restart and must not be trusted.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
  return {
    environment,
    commandKey: JSON.stringify(options.command),
    files,
    profileExists,
    fingerprint,
    key: JSON.stringify([options.command, files, profileExists, fingerprint]),
  };
}

type DshCatalogSnapshot = Awaited<ReturnType<typeof snapshot>>;

function sameDiscoveryInputs(before: DshCatalogSnapshot, after: DshCatalogSnapshot): boolean {
  return (
    before.commandKey === after.commandKey &&
    before.fingerprint === after.fingerprint &&
    (!before.profileExists || after.profileExists) &&
    before.files.every((file, index) => {
      const next = after.files[index]!;
      return (
        file.path === next.path &&
        (file.stamp === next.stamp ||
          (!before.profileExists && file.kind === "profile" && file.stamp === "missing"))
      );
    })
  );
}

/** Process-scoped metadata only: no timers, credentials reads, disk cache or native session deletion. */
export class DshCatalogDiscovery {
  #cached: { key: string; catalog: CodeAgentModelCatalog } | undefined;
  #inflight:
    | { context: Promise<DshCatalogSnapshot>; work: Promise<CodeAgentModelCatalog> }
    | undefined;

  constructor(private readonly exchange: typeof discoverDshCatalog = discoverDshCatalog) {}

  async cached(options: DshCatalogOptions): Promise<CodeAgentModelCatalog | undefined> {
    try {
      const { key } = await snapshot(options);
      return this.#cached?.key === key ? structuredClone(this.#cached.catalog) : undefined;
    } catch {
      // A stat failure is a cache miss, never a startup failure or proof of authentication.
      return undefined;
    }
  }

  async discover(options: DshCatalogOptions): Promise<CodeAgentModelCatalog> {
    for (;;) {
      const pending = this.#inflight;
      if (pending) {
        let failure: { error: unknown } | undefined;
        try {
          await pending.work;
        } catch (error) {
          failure = { error };
        }
        // A cold boot changes profile stats while the native session is still in flight.
        // Wait for cleanup, then re-read this request's inputs; never start a competing probe.
        const current = await snapshot(options);
        if (!options.force && this.#cached?.key === current.key)
          return structuredClone(this.#cached.catalog);
        const before = await pending.context.catch(() => undefined);
        if (!options.force && failure && before && sameDiscoveryInputs(before, current))
          throw failure.error; // Same request inputs share the failure, without an automatic retry.
        continue;
      }
      // Acquire the slot before snapshot I/O too, so even overlapping cold preflights cannot
      // miss a probe that materializes the profile and finishes while their stat calls are pending.
      const context = Promise.resolve().then(() => snapshot(options));
      const work = context.then((current) => {
        if (!options.force && this.#cached?.key === current.key) return this.#cached.catalog;
        return this.#probe(options, current);
      });
      const entry = { context, work };
      this.#inflight = entry;
      try {
        return structuredClone(await entry.work);
      } finally {
        if (this.#inflight === entry) this.#inflight = undefined;
      }
    }
  }

  async #probe(
    options: DshCatalogOptions,
    context: DshCatalogSnapshot,
  ): Promise<CodeAgentModelCatalog> {
    const environment = context.environment;
    let catalog: CodeAgentModelCatalog;
    let after: DshCatalogSnapshot;
    try {
      let cwd: string | undefined;
      try {
        cwd = await mkdtemp(join(tmpdir(), "coforge-dsh-catalog-"));
        catalog = await this.exchange({
          command: options.command,
          cwd,
          environment,
          host: dshRuntimeHost,
          timeoutMs: options.timeoutMs,
        });
        // First native boot may create the profile. Cache its resulting stat, not the missing state.
        after = await snapshot(options);
      } finally {
        if (cwd) await rm(cwd, { recursive: true, force: true });
      }
      if (sameDiscoveryInputs(context, after))
        this.#cached = { key: after.key, catalog: structuredClone(catalog) };
      return catalog;
    } catch (error) {
      if (error instanceof RuntimeVersionUnsupportedError) throw error;
      // Preserve the last successful metadata; the existing refresh error path reports failure.
      // Do not persist or forward native diagnostics, which may contain private configuration.
      throw new Error("DSH model catalog refresh failed");
    }
  }
}
