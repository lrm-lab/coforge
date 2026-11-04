import {
  assertDeliveryNotApplicationOrigin,
  normalizeDeliveryBaseUrl,
  type DeliveryUrlRule,
} from "#src/server/files/delivery-base-url.server";

/**
 * Where web-page artifacts are served from (task #490): an origin of their own, never the
 * application's, so a page an Agent wrote runs where none of our cookies, storage or pages are.
 * The page is sandboxed as well (an opaque origin, no network, `artifact-sandbox-response`); the
 * separate origin is what keeps a page opened in a tab of its own off our site even so.
 *
 * Env:
 * - `COFORGE_ARTIFACT_SANDBOX_ORIGIN` — e.g. `https://coforgeusercontent.com` in production, a
 *   test domain on staging. `https:` with no path, query or hash; plain `http:` only on a loopback
 *   host, for a local stack. It must not be the application's own origin. Unset leaves web pages
 *   off: a link to one is refused, and nothing is served.
 *
 * Read and checked at boot (`startup-config.server.ts`): a set value that breaks these rules
 * stops the deployment instead of failing the first page someone opens.
 */
export type ArtifactSandboxConfig = { origin: string } | null;

export class ArtifactSandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSandboxConfigError";
  }
}

const RULE: DeliveryUrlRule = {
  envVar: "COFORGE_ARTIFACT_SANDBOX_ORIGIN",
  fail: (message) => new ArtifactSandboxConfigError(message),
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function readArtifactSandboxConfig(env: NodeJS.ProcessEnv): ArtifactSandboxConfig {
  const raw = env.COFORGE_ARTIFACT_SANDBOX_ORIGIN?.trim();
  if (!raw) return null;
  const origin = loopbackHttpOrigin(raw) ?? normalizeDeliveryBaseUrl(raw, RULE);
  assertDeliveryNotApplicationOrigin(origin, env, RULE);
  return { origin };
}

/** A plain-`http:` origin on a loopback host (a local stack), or null for anything else. */
function loopbackHttpOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return null;
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

let remembered: ArtifactSandboxConfig = null;

/** Installed by the server entry after the boot check. */
export function rememberArtifactSandboxConfig(config: ArtifactSandboxConfig): void {
  remembered = config;
}

/** The sandbox origin of this deployment, or null when web pages are off. */
export function artifactSandboxOrigin(): string | null {
  return remembered?.origin ?? null;
}

/** Whether `request` was addressed to the sandbox origin's host. Behind the proxy the request
 * URL carries the client's `Host` (`public-origin.server.ts`), and the scheme is the proxy's, so
 * the host alone decides. */
export function isSandboxRequest(request: Request, origin: string | null): boolean {
  if (!origin) return false;
  return hostOf(new URL(request.url)) === hostOf(new URL(origin));
}

/** Host and port, a fully qualified name's trailing dot dropped: `sandbox.example.` is the same
 * host as `sandbox.example`, and must not reach the application under that spelling. */
function hostOf(url: URL): string {
  return `${url.hostname.replace(/\.$/, "")}:${url.port}`;
}
