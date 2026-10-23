/** Pure decisions behind the scheduled CDN certificate renewal (renew-cdn-certificates.ts). */
import domains from "./cdn-certificate-domains.json";

/** The CDN domains whose certificate the workflow keeps current: the one list in the repository. */
export const CDN_DOMAINS: readonly string[] = domains;

/** The DNS zone every CDN domain lives in; ACME TXT records are created inside it. */
export const DNS_ZONE = "coforge.cn";

/** Renew when fewer than this many days remain (Let's Encrypt certificates last 90). */
export const RENEW_BEFORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function needsRenewal(notAfter: Date, now: Date, force: boolean): boolean {
  if (force) return true;
  // An unreadable expiry is an error, never a reason to renew (and burn issuance budget).
  if (Number.isNaN(notAfter.getTime())) throw new Error("certificate expiry is not a valid date");
  return notAfter.getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS;
}

/** Name of the uploaded certificate in the CDN console: unique per upload. */
export function certName(domain: string, now: Date): string {
  return `cert-${domain}-${now.getTime()}`;
}

/** The TXT record name inside the zone for an ACME challenge host
 * (`_acme-challenge.docs.coforge.cn` -> `_acme-challenge.docs`). */
export function challengeRecordName(fullDomain: string): string {
  const suffix = `.${DNS_ZONE}`;
  if (!fullDomain.endsWith(suffix) || fullDomain.length === suffix.length)
    throw new Error(`challenge host is outside the ${DNS_ZONE} zone`);
  return fullDomain.slice(0, -suffix.length);
}

/** The date in `openssl x509 -noout -enddate` output (`notAfter=Jan 21 00:00:00 2027 GMT`); throws
 * when the output is missing or not a date. */
export function parseEndDate(output: string): Date {
  const line = output.trim();
  if (!line.startsWith("notAfter=")) throw new Error("no certificate expiry in openssl output");
  const date = new Date(line.slice("notAfter=".length));
  if (Number.isNaN(date.getTime())) throw new Error("certificate expiry is not a valid date");
  return date;
}

/** True when acme.sh's output shows Let's Encrypt refused to issue because of a rate limit. */
export function isRateLimited(output: string): boolean {
  return /rateLimited|too many (certificates|failed authorizations|new orders)/i.test(output);
}

/** Runs `work` up to `attempts` times, waiting `delayMs * attempt` between tries; throws the last error. */
export async function retry<T>(
  work: () => Promise<T>,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}
