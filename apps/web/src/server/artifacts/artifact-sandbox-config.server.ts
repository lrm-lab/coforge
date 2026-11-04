import {
  normalizeDeliveryBaseUrl,
  type DeliveryUrlRule,
} from "#src/server/files/delivery-base-url.server";

/**
 * Where web-page artifacts are served from (task #490): an origin of their own, never the
 * application's, so a page an Agent wrote runs where none of our cookies, storage or pages are.
 * The page is sandboxed as well (an opaque origin, `artifact-sandbox-response`); the separate
 * origin is what keeps a page opened in a tab of its own off our site even so.
 *
 * Env:
 * - `COFORGE_ARTIFACT_SANDBOX_ORIGIN` — e.g. `https://coforgeusercontent.com` in production, a
 *   test domain on staging. `https:` with no path, query or hash; plain `http:` only on a loopback
 *   host, for a local stack. Unset leaves web pages off: a link to one is refused, and nothing is
 *   served.
 *
 * It must not share a host with the application, nor be a subdomain of it or the other way
 * round: the sandbox host is matched by name alone, so the same name would hand the whole site to
 * the sandbox, and a parent domain's cookies would ride along to a subdomain. This is not a
 * same-site check: a sibling (`pages.x.com` beside `app.x.com`) passes it while being one site
 * with the application, so give the sandbox a registrable domain of its own. The application's
 * host is read from the settings that name it (`COFORGE_OIDC_ISSUER`, `COFORGE_GITHUB_CALLBACK_URL`);
 * with none set, boot goes on with a warning. Locally, give the sandbox the other loopback name
 * (`http://127.0.0.1:<port>` beside an app on `localhost`).
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
    if (sandbox === application) throw RULE.fail(`${ENV} must not be the application's own host`);
    if (sandbox.endsWith(`.${application}`) || application.endsWith(`.${sandbox}`))
      throw RULE.fail(`${ENV} must not be a subdomain of the application's host, nor its parent`);
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

/** Whether `request` was addressed to the sandbox's host. Behind the proxy the request URL
 * carries the client's `Host` (`public-origin.server.ts`) and the proxy's scheme, and a client
 * may spell the port out (`Host: sandbox.example:443`), so the host name alone decides. */
export function isSandboxRequest(request: Request, origin: string | null): boolean {
  if (!origin) return false;
  return hostnameOf(new URL(request.url)) === hostnameOf(new URL(origin));
}

/** The host name, lower case, a fully qualified name's trailing dot dropped: `sandbox.example.`
 * is the same host as `sandbox.example`, and must not reach the application under that spelling. */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}
