import {
  normalizeDeliveryBaseUrl,
  type DeliveryUrlRule,
} from "#src/server/files/delivery-base-url.server";

/**
 * Where web-page artifacts are served from: an origin per artifact, never the application's. A
 * page of artifact `<uuid>` lives only at `a-<uuid>.<sandbox host>` (scheme and port of the
 * configured origin), so the page runs where none of our cookies, storage or pages are, and where
 * no other artifact's storage is. The bare sandbox host serves nothing but a not-found page.
 *
 * Env:
 * - `COFORGE_ARTIFACT_SANDBOX_ORIGIN` — e.g. `https://coforgeusercontent.com` in production, a
 *   test domain on staging. `https:` with no path, query or hash; plain `http:` only on
 *   `localhost` (a local stack: Chrome resolves `*.localhost` to loopback, so
 *   `http://a-<uuid>.localhost:<port>` needs no DNS). An IP literal cannot carry a label, so it is
 *   refused. Unset leaves web pages off: a link to one is refused, and nothing is served.
 *
 * Every name under the sandbox host belongs to the sandbox: it is matched by suffix, so the
 * application's host must be neither the sandbox host nor under it. A subdomain of the
 * application is allowed as the sandbox (task #544 served `usercontent.coforge.cn`): every cookie
 * the application sets is host-only, so none reaches a subdomain. `test/artifact-sandbox.test.ts`
 * fails if a cookie ever gains a `Domain` attribute. The application's host is read from the
 * settings that name it (`COFORGE_OIDC_ISSUER`, `COFORGE_GITHUB_CALLBACK_URL`); with none set,
 * boot goes on with a warning. Locally, run the app on `127.0.0.1` beside a sandbox on `localhost`.
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

const ENV = "COFORGE_ARTIFACT_SANDBOX_ORIGIN";
const RULE: DeliveryUrlRule = {
  envVar: ENV,
  fail: (message) => new ArtifactSandboxConfigError(message),
};

/** The settings that name the application's own origin. */
const APPLICATION_ORIGIN_SETTINGS = ["COFORGE_OIDC_ISSUER", "COFORGE_GITHUB_CALLBACK_URL"] as const;

export function readArtifactSandboxConfig(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (message) => console.warn(message),
): ArtifactSandboxConfig {
  const raw = env[ENV]?.trim();
  if (!raw) return null;
  const origin = loopbackHttpOrigin(raw) ?? normalizeDeliveryBaseUrl(raw, RULE);
  const sandbox = hostnameOf(new URL(origin));
  const applications = applicationHostnames(env);
  if (applications.length === 0)
    warn(
      JSON.stringify({
        event: "artifact_sandbox_origin_unchecked",
        reason: `none of ${APPLICATION_ORIGIN_SETTINGS.join(", ")} names the application, so ${ENV} could not be checked against it`,
      }),
    );
  for (const application of applications) {
    if (application === sandbox || application.endsWith(`.${sandbox}`))
      throw RULE.fail(`${ENV} must not be the application's own host, nor a parent of it`);
  }
  return { origin };
}

/** The application's host names, from every setting that names its origin and parses. */
function applicationHostnames(env: NodeJS.ProcessEnv): string[] {
  return APPLICATION_ORIGIN_SETTINGS.flatMap((name) => {
    const value = env[name]?.trim();
    if (!value) return [];
    try {
      return [hostnameOf(new URL(value))];
    } catch {
      return [];
    }
  });
}

/** A plain-`http:` origin on `localhost` (a local stack), or null for anything else. */
function loopbackHttpOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost") return null;
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

const ARTIFACT_LABEL = /^a-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether `request` was addressed to the sandbox host or any name under it. Behind the proxy the
 * request URL carries the client's `Host` (`public-origin.server.ts`) and the proxy's scheme, and
 * a client may spell the port out (`Host: sandbox.example:443`), so the host name alone decides. */
export function isSandboxRequest(request: Request, origin: string | null): boolean {
  if (!origin) return false;
  const host = hostnameOf(new URL(request.url));
  const sandbox = hostnameOf(new URL(origin));
  return host === sandbox || host.endsWith(`.${sandbox}`);
}

/** Which name of the sandbox a request was addressed to: the bare host, one artifact's origin
 * (`a-<uuid>` directly under it), or any other name under it. */
export type SandboxTarget =
  | { kind: "bare" }
  | { kind: "artifact"; artifactId: string }
  | { kind: "other" };

export function sandboxTarget(request: Request, origin: string): SandboxTarget {
  const host = hostnameOf(new URL(request.url));
  const sandbox = hostnameOf(new URL(origin));
  if (host === sandbox) return { kind: "bare" };
  if (!host.endsWith(`.${sandbox}`)) return { kind: "other" };
  const artifactId = ARTIFACT_LABEL.exec(host.slice(0, -sandbox.length - 1))?.[1];
  return artifactId ? { kind: "artifact", artifactId } : { kind: "other" };
}

/** The origin of one artifact's pages: `a-<uuid>` under the sandbox host, the sandbox's scheme and
 * port. */
export function artifactPageOrigin(sandboxOrigin: string, artifactId: string): string {
  const url = new URL(sandboxOrigin);
  url.hostname = `a-${artifactId.toLowerCase()}.${url.hostname}`;
  return url.origin;
}

/** The host name, lower case, a fully qualified name's trailing dot dropped: `sandbox.example.`
 * is the same host as `sandbox.example`, and must not reach the application under that spelling. */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}
