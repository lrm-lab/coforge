import {
  normalizeDeliveryBaseUrl,
  type DeliveryUrlRule,
} from "#src/server/files/delivery-base-url.server";

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

export function isSandboxRequest(request: Request, origin: string | null): boolean {
  if (!origin) return false;
  const host = hostnameOf(new URL(request.url));
  const sandbox = hostnameOf(new URL(origin));
  return host === sandbox || host.endsWith(`.${sandbox}`);
}

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
