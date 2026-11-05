import { expect, test } from "bun:test";
import { forwardWebRequest } from "../../../scripts/e2e/same-origin-proxy";

test("the E2E proxy returns route redirects to the browser instead of rendering the destination at the original URL", async () => {
  const visited: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      visited.push(url.pathname + url.search);
      if (url.pathname === "/en/w/acme") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/en/w/acme/channel/general?tab=chat" },
        });
      }
      return new Response("Channel HTML");
    },
  });
  try {
    const response = await forwardWebRequest(
      new Request("http://proxy.test/en/w/acme?source=bookmark"),
      upstream.url.origin,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/en/w/acme/channel/general?tab=chat");
    expect(await response.text()).toBe("");
    expect(visited).toEqual(["/en/w/acme?source=bookmark"]);
  } finally {
    upstream.stop(true);
  }
});

test("the E2E proxy hands on a compressed answer decoded, without its Content-Encoding", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(Bun.gzipSync("File under review"), {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
      }),
  });
  try {
    const response = await forwardWebRequest(
      new Request("http://proxy.test/api/attachments/1"),
      upstream.url.origin,
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("File under review");
  } finally {
    upstream.stop(true);
  }
});
