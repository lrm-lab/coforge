import { describe, expect, test } from "bun:test";
import { FEED_READ_TIMEOUT_MS, feedOssConnection, type FeedFetch, readFeedObject } from "./public-feed";

/** A fetch that answers from `answers` in order, then repeats the last one. */
function scripted(...answers: (() => Promise<Response>)[]): {
  fetch: FeedFetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetch: FeedFetch = async (url) => {
    calls.push(url);
    const answer = answers[Math.min(index++, answers.length - 1)]!;
    return answer();
  };
  return { fetch, calls };
}

const ok = (body: string) => async () => new Response(body, { status: 200 });
const status = (code: number) => async () => new Response("", { status: code });
const timeout = () => () =>
  Promise.reject(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));

const options = { retryDelaysMs: [0, 0], log: () => {} };

describe("reading a public release feed", () => {
  test("a 200 is the object's text, read once", async () => {
    const { fetch, calls } = scripted(ok("1.2.3\n"));
    await expect(
      readFeedObject("https://cdn.example/feed/", "installer/latest", fetch),
    ).resolves.toBe("1.2.3\n");
    expect(calls).toEqual(["https://cdn.example/feed/installer/latest"]);
  });

  test("a stalled read says which URL stalled, then the retry lands", async () => {
    const lines: string[] = [];
    const { fetch, calls } = scripted(timeout(), ok("1.2.4\n"));
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, {
        ...options,
        log: (line) => lines.push(line),
      }),
    ).resolves.toBe("1.2.4\n");
    expect(calls).toHaveLength(2);
    expect(lines).toEqual([
      `https://cdn.example/feed/installer/latest: no response within ${FEED_READ_TIMEOUT_MS} ms; retrying in 0 ms (retry 1 of 2)`,
    ]);
  });

  test("a 5xx is transient and retried", async () => {
    const { fetch, calls } = scripted(status(503), ok("1.2.5\n"));
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, options),
    ).resolves.toBe("1.2.5\n");
    expect(calls).toHaveLength(2);
  });

  test("a missing object is the feed's answer, not retried", async () => {
    const { fetch, calls } = scripted(status(404));
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, options),
    ).rejects.toThrow("https://cdn.example/feed/installer/latest: HTTP 404");
    expect(calls).toHaveLength(1);
  });

  test("a read that never lands gives up after the retries, naming the URL", async () => {
    const { fetch, calls } = scripted(timeout());
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, options),
    ).rejects.toThrow(
      `https://cdn.example/feed/installer/latest: no response within ${FEED_READ_TIMEOUT_MS} ms`,
    );
    expect(calls).toHaveLength(3);
  });

  test("a dropped connection is transient and names the URL too", async () => {
    const dropped = () =>
      Promise.reject(Object.assign(new Error("connection reset"), { name: "TypeError" }));
    const { fetch } = scripted(dropped, ok("1.2.6\n"));
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, options),
    ).resolves.toBe("1.2.6\n");
  });

  test("a small deadline is honoured per attempt", async () => {
    const seen: number[] = [];
    const fetch: FeedFetch = async (_url, init) => {
      seen.push(init?.signal instanceof AbortSignal ? 1 : 0);
      throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    };
    await expect(
      readFeedObject("https://cdn.example/feed", "installer/latest", fetch, {
        ...options,
        retryDelaysMs: [],
        timeoutMs: 5,
      }),
    ).rejects.toThrow("no response within 5 ms");
    expect(seen).toEqual([1]);
  });

  test("an OSS client reads the object, not the CDN URL", async () => {
    const { fetch, calls } = scripted(ok("unreached"));
    const read: string[] = [];
    const oss = { get: async (key: string) => { read.push(key); return { content: Buffer.from("1.2.6\n") }; } };
    await expect(
      readFeedObject("https://releases.coforge.cn", "latest", fetch, { ...options, oss }),
    ).resolves.toBe("1.2.6\n");
    expect(read).toEqual(["latest"]);
    expect(calls).toEqual([]);
  });

  test("an OSS 4xx is the feed's answer, not retried; a 5xx is", async () => {
    const failures: number[] = [];
    let attempt = 0;
    const oss = {
      get: async (_key: string) => {
        attempt++;
        if (attempt === 1) { failures.push(0); throw Object.assign(new Error("denied"), { status: 403 }); }
        return { content: "1.2.7\n" };
      },
    };
    await expect(
      readFeedObject("https://releases.coforge.cn", "latest", scripted()["fetch"], { ...options, oss }),
    ).rejects.toThrow("oss://releases.coforge.cn/latest: denied");
    expect(attempt).toBe(1);

    let five = 0;
    const retryable = {
      get: async (_key: string) => {
        five++;
        if (five === 1) throw Object.assign(new Error("busy"), { status: 503 });
        return { content: "1.2.8\n" };
      },
    };
    await expect(
      readFeedObject("https://releases.coforge.cn", "latest", scripted()["fetch"], { ...options, oss: retryable }),
    ).resolves.toBe("1.2.8\n");
    expect(five).toBe(2);
  });

  test("the known feeds name their backing buckets", () => {
    expect(feedOssConnection("https://releases.coforge.cn")).toEqual({
      bucket: "coforge-releases",
      endpoint: "oss-accelerate.aliyuncs.com",
      region: "oss-cn-beijing",
    });
    expect(feedOssConnection("https://releases-staging.coforge.cn")).toEqual({
      bucket: "coforge-releases-staging",
      endpoint: "oss-accelerate.aliyuncs.com",
      region: "oss-cn-beijing",
    });
    expect(feedOssConnection("https://cdn.example/feed")).toBeUndefined();
  });
});
