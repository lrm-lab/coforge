import OSS from "ali-oss";
import Credential from "@alicloud/credentials";

/** The release-reader role a job assumes only for feed reads. The staging publish's own role
 * writes its bucket but may not read the production feed's, and the candidate job holds no
 * Alibaba credential at all — so feed reads take their own OIDC chain when these are set, and
 * fall back to the job's ambient chain when they are not (the candidate job's role IS the
 * reader). `COFORGE_FEED_OIDC_PROVIDER_ARN` and the token file reuse the standard GitHub OIDC
 * env names, which the workflow's OIDC step already exports. */
const FEED_ROLE_ARN_ENV = "COFORGE_FEED_ROLE_ARN";
const FEED_OIDC_PROVIDER_ENV = "COFORGE_FEED_OIDC_PROVIDER_ARN";

/** The ali-oss client the release scripts share, and the connection/credential types it takes. */

export interface OssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
}

/** Where the object store lives. Production always uses the real bucket over HTTPS
 * (virtual-hosted-style: `https://<bucket>.<endpoint>/<key>`); tests override `endpoint` to a
 * local fixture server and set `cname: true` (so the SDK talks to that host directly instead of
 * prefixing it with the bucket name) and `secure: false`. */
export interface OssConnection {
  bucket: string;
  endpoint: string;
  /** The bucket's region id (`oss-cn-beijing`), which V4 signing writes into every request's
   * credential scope. ali-oss does not derive it from `endpoint` and silently defaults to
   * `oss-cn-hangzhou`, and OSS rejects a scope for the wrong region with `InvalidArgument`.
   * Defaults to the region named by a public `oss-<region>.aliyuncs.com` endpoint. */
  region?: string;
  cname?: boolean;
  secure?: boolean;
}

/** The region id a public OSS endpoint names (`oss-cn-beijing.aliyuncs.com` -> `oss-cn-beijing`),
 * or undefined for any other host (a fixture server, a custom domain, or a global transfer
 * acceleration endpoint such as `oss-accelerate.aliyuncs.com`, which names no region). */
export function regionFromEndpoint(endpoint: string): string | undefined {
  const host = endpoint.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "");
  if (/^oss-accelerate(?:-overseas)?\.aliyuncs\.com$/i.test(host)) return undefined;
  const match = /^(oss-[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/i.exec(host);
  return match?.[1];
}

/** Builds the ali-oss client this script uploads through, with V4 signing (`authorizationV4:
 * true`) - see publish.ts's file banner for why V1 is no longer an option for this bucket.
 * `credentials`, when given, is used as-is; this is how tests point the client at a local fixture
 * server with static test credentials. Without it, credentials come from the
 * `@alicloud/credentials` default chain, and `refreshSTSToken` re-reads that chain whenever the
 * resolved credential carries a security token - the same pattern `apps/web`'s OSS file storage
 * uses - so a client built from a federated STS token does not start signing with an expired one
 * partway through a publish that compiled six targets before it ever made a network call. */
export async function createOssClient(
  connection: OssConnection,
  credentials?: OssCredentials,
): Promise<OSS> {
  const region = connection.region ?? regionFromEndpoint(connection.endpoint);
  if (!region) {
    throw new Error(
      `cannot derive the OSS region from endpoint ${connection.endpoint}; pass --region (V4 ` +
        "signing needs the bucket's region in every request)",
    );
  }
  const base = {
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    region,
    cname: connection.cname ?? false,
    secure: connection.secure ?? true,
    authorizationV4: true,
    // Transient transport errors (-1/-2: reset, connect timeout) retry at the SDK level. A response
    // timeout carries no status, so it is putObject's own retry loop that rescues it.
    retryMax: 2,
  };
  if (credentials) {
    return new OSS({ ...credentials, ...base });
  }
  const chain = new Credential();
  return ossClientFromChain(base, chain);
}

/** The feed-read client: its own reader-role chain when `COFORGE_FEED_ROLE_ARN` is configured,
 * else the ambient chain — the two jobs that read feeds carry the right role either way. */
export async function createFeedOssClient(connection: OssConnection): Promise<OSS> {
  const region = connection.region ?? regionFromEndpoint(connection.endpoint);
  if (!region) {
    throw new Error(
      `cannot derive the OSS region from endpoint ${connection.endpoint}; pass --region (V4 ` +
        "signing needs the bucket's region in every request)",
    );
  }
  const base = {
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    region,
    cname: connection.cname ?? false,
    secure: connection.secure ?? true,
    authorizationV4: true,
    retryMax: 2,
  };
  const roleArn = process.env[FEED_ROLE_ARN_ENV];
  if (roleArn) {
    const oidcProviderArn =
      process.env[FEED_OIDC_PROVIDER_ENV] ?? process.env.ALIBABA_CLOUD_OIDC_PROVIDER_ARN;
    const oidcTokenFilePath = process.env.ALIBABA_CLOUD_OIDC_TOKEN_FILE;
    if (!oidcProviderArn || !oidcTokenFilePath) {
      throw new Error(
        `${FEED_ROLE_ARN_ENV} is set but the OIDC provider/token envs are missing; the job ` +
          "needs id-token: write and the OIDC step's ALIBABA_CLOUD_OIDC_PROVIDER_ARN / " +
          "ALIBABA_CLOUD_OIDC_TOKEN_FILE",
      );
    }
    return ossClientFromChain(
      base,
      new Credential({ type: "oidc_role_arn", roleArn, oidcProviderArn, oidcTokenFilePath }),
    );
  }
  return ossClientFromChain(base, new Credential());
}

async function ossClientFromChain(
  base: {
    bucket: string;
    endpoint: string;
    region: string;
    cname: boolean;
    secure: boolean;
    authorizationV4: boolean;
    retryMax: number;
  },
  chain: Credential,
): Promise<OSS> {
  const readCredential = async (): Promise<OssCredentials> => {
    const credential = await chain.getCredential();
    if (!credential.accessKeyId || !credential.accessKeySecret) {
      throw new Error(
        "Alibaba Cloud credential chain returned no AccessKey; set ALIBABA_CLOUD_ROLE_ARN, " +
          "ALIBABA_CLOUD_OIDC_PROVIDER_ARN and ALIBABA_CLOUD_OIDC_TOKEN_FILE for GitHub OIDC, or " +
          "ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET locally (or pass --dry-run).",
      );
    }
    return {
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken ?? undefined,
    };
  };
  const initial = await readCredential();
  return new OSS({
    ...initial,
    ...base,
    ...(initial.stsToken ? { refreshSTSToken: readCredential } : {}),
  });
}
