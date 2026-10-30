/**
 * Reads of a public release feed's objects. The anonymous path reads the feed's CDN URL, which a
 * domestic host answers in seconds but an overseas GitHub runner often cannot reach at all; a
 * caller that already holds OSS credentials instead passes an `oss` client and the same object is
 * read over the proven `oss-accelerate` channel the publish itself uploads through. A feed's
 * object keys are publish.ts's (`LATEST_OBJECT_KEY`, `manifestObjectKey`) and
 * installer-feed.ts's.
 */

/** The fetch a feed read uses; tests inject one that answers from fixtures. */
export type FeedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** How long one attempt may stall before it counts as failed. */
export const FEED_READ_TIMEOUT_MS = 30_000;

/** Waits before each retry. A CI runner overseas reading a domestic origin hits stalled
 * connections that are transient, and one retry after a pause usually lands. A missing object is
 * not retried — it will not appear — and the deadline itself stays where it is: a slow origin is
 * not made fast by waiting longer. */
export const DEFAULT_FEED_RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];

/** A release feed's backing OSS connection. The CDN domain is the public face; the object
 * itself lives in the feed's bucket and is reachable (with credentials) through the same
 * cross-border acceleration endpoint the upload proves on every publish. Unknown feeds stay
 * anonymous. */
const FEED_OSS_CONNECTIONS: Readonly<Record<string, { bucket: string }>> = {
  "https://releases.coforge.cn": { bucket: "coforge-releases" },
  "https://releases-staging.coforge.cn": { bucket: "coforge-releases-staging" },
};

const FEED_OSS_ENDPOINT = "oss-accelerate.aliyuncs.com";
const FEED_OSS_REGION = "oss-cn-beijing";

/** The OSS connection a public feed URL backs onto, or `undefined` when the feed is not one of
 * the known release buckets. */
export function feedOssConnection(
  feedUrl: string,
): { bucket: string; endpoint: string; region: string } | undefined {
  const known = FEED_OSS_CONNECTIONS[feedUrl.replace(/\/+$/, "")];
  if (!known) return undefined;
  return { bucket: known.bucket, endpoint: FEED_OSS_ENDPOINT, region: FEED_OSS_REGION };
}

export type FeedReadOptions = {
  /** Waits before each retry; the number of entries is the number of retries. */
  retryDelaysMs?: readonly number[];
  /** Where a failed attempt says so; the default is this process's warning line. */
  log?: (line: string) => void;
  /** One attempt's deadline; the default is `FEED_READ_TIMEOUT_MS`. */
  /** Reads `key` through an OSS client (already bucket-bound) instead of the anonymous CDN URL.
   * The accelerate endpoint rejects anonymous reads, so this is the only OSS path. */
  oss?: { get(key: string): Promise<{ content: unknown }> };
};

/**
 * The text of one feed object, retried with backoff while the failure could be transient. A
 * stalled or dropped connection and a 5xx are; a 4xx is the feed's own answer and is thrown at
 * once. Every failure names the URL, which is what tells a release job which origin to look at.
 */
export async function readFeedObject(
  feedUrl: string,
  key: string,
  fetch: FeedFetch,
  options: FeedReadOptions = {},
): Promise<string> {
  const url = options.oss
    ? `oss://${feedUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${key}`
    : `${feedUrl.replace(/\/+$/, "")}/${key}`;
  const delays = options.retryDelaysMs ?? DEFAULT_FEED_RETRY_DELAYS_MS;
  const log = options.log ?? ((line: string) => console.warn(line));
  const timeoutMs = options.timeoutMs ?? FEED_READ_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return options.oss
        ? await readOnceOss(url, key, options.oss, timeoutMs)
        : await readOnce(url, fetch, timeoutMs);
    } catch (error) {
      if (!(error instanceof FeedReadError) || !error.transient || attempt >= delays.length)
        throw error;
      const delay = delays[attempt]!;
      log(`${error.message}; retrying in ${delay} ms (retry ${attempt + 1} of ${delays.length})`);
      await Bun.sleep(delay);
    }
  }
}

/** A failed feed read that knows whether another attempt could succeed. */
class FeedReadError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "FeedReadError";
  }
}

async function readOnceOss(
  url: string,
  key: string,
  oss: { get(key: string): Promise<{ content: unknown }> },
  timeoutMs: number,
): Promise<string> {
  let result: { content: unknown };
  try {
    result = await Promise.race([
      oss.get(key),
      Bun.sleep(timeoutMs).then(() => {
        throw new FeedReadError(`${url}: no response within ${timeoutMs} ms`, true);
      }),
    ]);
  } catch (error) {
    if (error instanceof FeedReadError) throw error;
    // ali-oss carries the HTTP status on `status`; 4xx is the object's own answer, not transient.
    const status = (error as { status?: number }).status;
    throw new FeedReadError(
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
      status === undefined || status >= 500,
    );
  }
  const content = result.content;
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array || Buffer.isBuffer(content))
    return new TextDecoder().decode(content as Uint8Array);
  throw new FeedReadError(`${url}: unreadable object content`, false);
}

async function readOnce(url: string, fetch: FeedFetch, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // A deadline the fetch named is a timeout; the URL belongs in the line either way.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new FeedReadError(
      timedOut
        ? `${url}: no response within ${timeoutMs} ms`
        : `${url}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok)
    throw new FeedReadError(`${url}: HTTP ${response.status}`, response.status >= 500);
  try {
    return await response.text();
  } catch (error) {
    // The status arrived but the body did not: the same transient read failure.
    throw new FeedReadError(
      `${url}: response body failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
