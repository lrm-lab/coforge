// Fixtures shared by the deploy test files.
export const digest = `sha256:${"a".repeat(64)}`;
export const registryImage = `registry.cn-hangzhou.aliyuncs.com/coforge/web@${digest}`;

export const requiredSecretNames = [
  "authing_app_id",
  "authing_app_secret",
  "coforge_session_secret",
  "coforge_agent_credential_encryption_key",
  "coforge_web_push_public_key",
  "coforge_web_push_private_key",
  "coforge_file_delivery_key",
  "postgres_password",
  "redis_password",
  "centrifugo_http_api_key",
  "centrifugo_proxy_secret",
  "centrifugo_token_hmac_secret_key",
  "worker_jwt_key_id",
  "worker_jwt_private_jwk",
];

export type ComposeSecretGrant =
  | string
  | { source: string; uid?: string; gid?: string; mode?: number };
export type ComposeFile = {
  services: Record<
    string,
    { command?: string[]; environment?: Record<string, string>; secrets?: ComposeSecretGrant[] }
  >;
  secrets: Record<string, { file?: string; environment?: string }>;
};

export const readCompose = async (environment: string) =>
  Bun.YAML.parse(
    await Bun.file(
      new URL(`../../infra/${environment}/docker-compose.yml`, import.meta.url),
    ).text(),
  ) as ComposeFile;
