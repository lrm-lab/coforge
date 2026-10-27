import type { AuthingConfig } from "./authing-authentication.server";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/**
 * The Authing app CoForge signs people in against. `AUTHING_ISSUER` is the app's OIDC issuer
 * (`https://<app>.authing.cn/oidc`); the Authentication API is served from the same host.
 */
export async function readAuthingConfig(env: NodeJS.ProcessEnv): Promise<AuthingConfig> {
  const appId = await required(env, "AUTHING_APP_ID");
  const appSecret = await required(env, "AUTHING_APP_SECRET");
  const issuer = httpsIssuer(await required(env, "AUTHING_ISSUER"));
  return {
    appId,
    appSecret,
    appHost: new URL(issuer).origin,
    userinfoEndpoint: `${issuer}/me`,
    revocationEndpoint: `${issuer}/token/revocation`,
  };
}

/** What signing in and out needs: the Authing app and the secret sessions are signed with. */
export async function readSignInConfig(
  env: NodeJS.ProcessEnv,
): Promise<{ config: AuthingConfig; sessionSecret: string }> {
  const [config, sessionSecret] = await Promise.all([
    readAuthingConfig(env),
    readSessionSecret(env),
  ]);
  return { config, sessionSecret };
}

/** `readSignInConfig`, or `null` when the deployment lacks the configuration (which the boot
 * check already reports); the sign-in then fails like any other failure. */
export async function readSignInConfigOrNull(
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof readSignInConfig>> | null> {
  try {
    return await readSignInConfig(env);
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
}

/** Where a person is sent to authorize CoForge at GitHub. */
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** What signing in with GitHub needs, beyond the Authing app. */
export type GitHubSignInConfig = {
  /** The client id of the GitHub OAuth app people authorize; public. */
  clientId: string;
  /** The identifier of the Authing connection that exchanges GitHub's code (`github-mobile`). */
  connection: string;
  authorizeUrl: string;
};

/**
 * The GitHub sign-in: `COFORGE_GITHUB_SIGN_IN_CLIENT_ID` and `AUTHING_GITHUB_CONNECTION`, or `null`
 * when neither is set, which leaves it off. Only one of them set is a mistake, and so is a
 * `COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL` that is not HTTPS (or HTTP on a loopback host); both throw
 * `AuthConfigError`. That URL exists for the browser e2e, which points it at a stand-in for GitHub;
 * a deployment leaves it unset. These are not the `COFORGE_GITHUB_*` settings of the GitHub App
 * integration (`server/integrations/github-config.server.ts`).
 */
export function readGitHubSignInConfig(env: NodeJS.ProcessEnv): GitHubSignInConfig | null {
  const clientId = env.COFORGE_GITHUB_SIGN_IN_CLIENT_ID?.trim();
  const connection = env.AUTHING_GITHUB_CONNECTION?.trim();
  if (!clientId && !connection) return null;
  if (!clientId || !connection) {
    throw new AuthConfigError(
      "COFORGE_GITHUB_SIGN_IN_CLIENT_ID and AUTHING_GITHUB_CONNECTION must be set together",
    );
  }
  const authorizeUrl = env.COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL?.trim() || GITHUB_AUTHORIZE_URL;
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    throw new AuthConfigError("COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL must be a valid URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AuthConfigError(
      "COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL must be HTTPS without credentials, query or fragment",
    );
  }
  return { clientId, connection, authorizeUrl };
}

let reportedGitHubMisconfiguration = false;

/** `readGitHubSignInConfig`, or `null` when it is off or the configuration is wrong (logged once
 * per process, without the values, though every `/login` load asks): a misconfigured GitHub
 * sign-in leaves the other ways of signing in alone. */
export function readGitHubSignInConfigOrNull(env: NodeJS.ProcessEnv): GitHubSignInConfig | null {
  try {
    return readGitHubSignInConfig(env);
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    if (!reportedGitHubMisconfiguration) {
      reportedGitHubMisconfiguration = true;
      console.error(JSON.stringify({ event: "auth.github_sign_in_misconfigured" }));
    }
    return null;
  }
}

export async function readSessionSecret(env: NodeJS.ProcessEnv): Promise<string> {
  const secret = await required(env, "COFORGE_SESSION_SECRET");
  if (secret.length < 32) {
    throw new AuthConfigError("COFORGE_SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

async function required(env: NodeJS.ProcessEnv, name: string): Promise<string> {
  const inlineValue = env[name]?.trim();
  const fileName = `${name}_FILE`;
  const filePath = env[fileName]?.trim();
  if (inlineValue && filePath) {
    throw new AuthConfigError(`${name} and ${fileName} cannot both be set`);
  }

  let value = inlineValue;
  if (filePath) {
    try {
      // Official file read: https://bun.com/docs/runtime/file-io
      value = (await Bun.file(filePath).text()).trim();
    } catch {
      throw new AuthConfigError(`${fileName} could not be read`);
    }
  }
  if (!value) throw new AuthConfigError(`${name} is required`);
  return value;
}

function httpsIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError("AUTHING_ISSUER must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new AuthConfigError("AUTHING_ISSUER must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AuthConfigError("AUTHING_ISSUER must not contain credentials, query, or fragment");
  }
  return value.replace(/\/$/, "");
}
