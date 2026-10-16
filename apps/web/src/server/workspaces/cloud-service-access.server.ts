import { timingSafeEqual } from "node:crypto";

/** How long one correct password keeps the cloud computer service page operable. */
export const CLOUD_SERVICE_UNLOCK_SECONDS = 15 * 60;

const COOKIE = "coforge_cloud_service";
const ATTEMPT_LIMIT = 8;
const ATTEMPT_WINDOW_MS = 60_000;
const PURPOSE = "cloud-service-unlock";

export function cloudServicePasswordConfigured(configured: string | undefined): boolean {
  return usablePassword(configured) !== undefined;
}

/** Compares the typed password with the deployment's operating password. */
export function cloudServicePasswordAccepted(
  presented: string,
  configured: string | undefined,
): boolean {
  const expected = usablePassword(configured);
  if (!expected) return false;
  const left = sha256(presented);
  const right = sha256(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sealCloudServiceUnlock(now: Date, secret: string): string {
  const exp = String(now.getTime() + CLOUD_SERVICE_UNLOCK_SECONDS * 1000);
  return `${exp}.${hmac(secret, `${PURPOSE}.${exp}`)}`;
}

export function cloudServiceUnlockValid(
  token: string | undefined,
  now: Date,
  secret: string,
): boolean {
  if (!token || secret.length < 32) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || mac.length === 0) return false;
  const expected = hmac(secret, `${PURPOSE}.${exp}`);
  const actual = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
  return Number(exp) > now.getTime();
}

export function serializeCloudServiceCookie(token: string, secure: boolean): string {
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${CLOUD_SERVICE_UNLOCK_SECONDS}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCloudServiceCookie(secure: boolean): string {
  return [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", secure ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

export function cloudServiceCookieValue(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

/** Refuses a burst of password attempts for one person. */
export class CloudServiceAttempts {
  private readonly hits = new Map<string, number[]>();

  allowed(key: string, now: Date): boolean {
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => now.getTime() - at < ATTEMPT_WINDOW_MS,
    );
    if (recent.length >= ATTEMPT_LIMIT) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(key, recent);
    return true;
  }
}

function usablePassword(value: string | undefined): string | undefined {
  const password = value?.trim() ?? "";
  if (password.length < 6 || password.length > 200) return undefined;
  return password;
}

function sha256(value: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(value).digest());
}

function hmac(secret: string, value: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(value);
  return Buffer.from(hasher.digest()).toString("base64url");
}
