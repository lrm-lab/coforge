import { afterAll, beforeAll } from "bun:test";

import { UpdateError } from "#src/updater";

/** Shared by the `obtainInstaller` tests: a loopback installer feed and the host isolation. */

// curl inherits the process environment. A proxy setting on the host would send loopback
// requests to the proxy, so the host, not the code, would decide these tests' outcome.
const proxyVariables = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;
const hostEnvironment = new Map<string, string | undefined>();

export function isolateProxyEnvironment(): void {
  beforeAll(() => {
    for (const name of proxyVariables) {
      hostEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.NO_PROXY = "127.0.0.1,localhost";
    process.env.no_proxy = "127.0.0.1,localhost";
  });

  afterAll(() => {
    for (const [name, value] of hostEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

export function sha256hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export type InstallerEntry = {
  file: string;
  size: number;
  checksum: string;
  gzip: { file: string; size: number; checksum: string };
};
export type InstallerManifest = {
  schema_version: number;
  version: string;
  platforms: Record<string, { installer: InstallerEntry }>;
  [key: string]: unknown;
};

/** What a release of the installer publishes for one target. */
export function release(version: string, target: string) {
  const windows = target.startsWith("windows-");
  const binary = Buffer.from(`#!/bin/sh\n# coforge-installer ${version}\nexit 0\n`);
  const gzip = Bun.gzipSync(binary);
  const manifest: InstallerManifest = {
    schema_version: 1,
    version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    buildDate: "2026-09-30T00:00:00.000Z",
    installer_protocol: 1,
    platforms: {
      [target]: {
        installer: {
          file: windows ? "coforge-installer.exe" : "coforge-installer",
          size: binary.byteLength,
          checksum: sha256hex(binary),
          gzip: {
            file: windows ? "coforge-installer.exe.gz" : "coforge-installer.gz",
            size: gzip.byteLength,
            checksum: sha256hex(gzip),
          },
        },
      },
    },
  };
  return { version, target, binary, gzip, manifest };
}

/** The installer feed: `installer/latest`, `installer/<v>/manifest.json`, and the target's gzip. */
export function startFeed(servers: Array<ReturnType<typeof Bun.serve>>, target = "linux-x64") {
  const routes = new Map<string, () => Response | Promise<Response>>();
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      return routes.get(path)?.() ?? new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const feed = {
    /** What the Computer knows as its release feed; the installer lives under `installer/`. */
    url: `http://127.0.0.1:${server.port}`,
    target,
    requested,
    route(path: string, respond: () => Response | Promise<Response>) {
      routes.set(`/installer/${path}`, respond);
    },
    /** Publishes a version; `tamper` may change what the feed serves before it is served. */
    publish(
      version: string,
      tamper?: (published: ReturnType<typeof release>) => void,
      pointTo: boolean = true,
    ) {
      const published = release(version, target);
      tamper?.(published);
      const entry = published.manifest.platforms[target]?.installer;
      feed.route(`${version}/manifest.json`, () => Response.json(published.manifest));
      feed.route(`${version}/${target}/${entry?.gzip.file ?? "coforge-installer.gz"}`, () => {
        return new Response(Buffer.from(published.gzip));
      });
      if (pointTo) feed.point(`${version}\n`);
      return published;
    },
    point(pointer: string) {
      feed.route("latest", () => new Response(pointer));
    },
  };
  return feed;
}

export async function failureOf(operation: Promise<unknown>): Promise<UpdateError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof UpdateError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail with an UpdateError");
}
