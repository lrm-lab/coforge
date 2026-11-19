import type { AuthingConfig } from "./authing-authentication.server";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

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

export async function readAuthingConfigOrNull(
  env: NodeJS.ProcessEnv,
): Promise<AuthingConfig | null> {
  try {
    return await readAuthingConfig(env);
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
}

export async function readSignInConfig(
  env: NodeJS.ProcessEnv,
): Promise<{ config: AuthingConfig; sessionSecret: string }> {
  const [config, sessionSecret] = await Promise.all([
    readAuthingConfig(env),
    readSessionSecret(env),
  ]);
  return { config, sessionSecret };
}

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

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export type GitHubSignInConfig = {
  clientId: string;
  connection: string;
  authorizeUrl: string;
};

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

export function signInMethods(env: NodeJS.ProcessEnv): { github: boolean } {
  return { github: readGitHubSignInConfigOrNull(env) !== null };
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
