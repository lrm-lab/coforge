import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { UsageUnavailableError, asRecord as record } from "@lrm/coforge-anvil";

// Kiro's private CLI store/API, also consumed by CodexBar. Never refresh or
// migrate this store. Unknown identities and schemas fail closed.
export async function readKiroUsageResponse(
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<unknown> {
  const environment = options.environment ?? Bun.env;
  const home = environment.HOME ?? homedir();
  const expand = (value: string | undefined) => {
    const path = value?.trim();
    return path?.startsWith("~/") ? join(home, path.slice(2)) : path;
  };
  const root =
    expand(environment.KIRO_DATA_DIR) ||
    ((options.platform ?? process.platform) === "darwin"
      ? join(home, "Library/Application Support/kiro-cli")
      : join(expand(environment.XDG_DATA_HOME) || join(home, ".local/share"), "kiro-cli"));
  if (!isAbsolute(root)) return undefined;
  const path = join(root, "data.sqlite3");
  if (!(await Bun.file(path).exists())) return undefined;
  let db: Database | undefined;
  let token: Record<string, unknown> | undefined;
  let profile: Record<string, unknown> | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250; BEGIN");
    const authRow = db
      .query<{ value: string }, []>("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'")
      .get();
    const profileRow = db
      .query<{ value: string }, []>(
        "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'",
      )
      .get();
    token = record(JSON.parse(authRow?.value ?? "null"));
    profile = record(JSON.parse(profileRow?.value ?? "null"));
    db.exec("COMMIT");
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
  if (typeof token?.access_token !== "string" || !token.access_token.trim()) return undefined;
  if (
    token.expires_at !== undefined &&
    (typeof token.expires_at !== "string" ||
      !Number.isFinite(Date.parse(token.expires_at)) ||
      Date.parse(token.expires_at) <= Date.now())
  )
    return undefined;
  const arn = profile?.arn;
  // Reject control characters in native profile data before constructing auth headers.
  // oxlint-disable-next-line no-control-regex
  if (typeof arn !== "string" || /\s|[\u0000-\u001f\u007f]/u.test(arn)) return undefined;
  const match = /^arn:aws:codewhisperer:(us-east-1|eu-central-1):[0-9]{12}:profile\/.+$/.exec(arn);
  if (!match) return undefined;
  const endpoint =
    match[1] === "us-east-1"
      ? "https://codewhisperer.us-east-1.amazonaws.com/"
      : "https://q.eu-central-1.amazonaws.com/";
  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
      },
      body: JSON.stringify({ profileArn: arn }),
    });
    if (response.status === 401 || response.status === 403) return undefined;
    if (!response.ok) throw new Error("Kiro usage unavailable");
    return await response.json();
  } catch (error) {
    // An injected requester may already have classified unavailability. Preserve that error.
    if (error instanceof UsageUnavailableError) throw error;
    // Transport errors may include request headers or local paths.
    throw new Error("Kiro usage request failed");
  }
}
