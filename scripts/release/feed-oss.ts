import { feedOssConnection } from "./public-feed";
import { createFeedOssClient } from "./oss-client";

/** Resolves the client a feed URL's objects are read through: `undefined` (anonymous CDN) unless
 * `--feed-oss` is on and the URL maps to an OSS bucket, in which case the release-reader or
 * ambient credentials drive a shared accelerated client, memoized per feed. */
export function feedOssResolver(enabled: boolean) {
  const clients = new Map<
    string,
    Promise<{ get(key: string): Promise<{ content: unknown }> } | undefined>
  >();
  if (!enabled) return undefined;
  return (feedUrl: string) => {
    if (!clients.has(feedUrl)) {
      const connection = feedOssConnection(feedUrl);
      clients.set(
        feedUrl,
        connection ? createFeedOssClient(connection) : Promise.resolve(undefined),
      );
    }
    return clients.get(feedUrl)!;
  };
}
