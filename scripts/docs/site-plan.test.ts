import { describe, expect, test } from "bun:test";

import {
  assertDistUsable,
  cacheControlFor,
  contentTypeFor,
  listPageQuery,
  staleKeys,
  uploadOrder,
} from "./site-plan";

describe("docs site publishing", () => {
  test("a bucket listing page names a marker only when it continues one", () => {
    // ali-oss signs an undefined marker differently from the request it sends, so the
    // first page must not carry the key at all (SignatureDoesNotMatch otherwise).
    expect(listPageQuery(undefined)).toEqual({ "max-keys": 1000 });
    expect("marker" in listPageQuery(undefined)).toBe(false);
    expect(listPageQuery("assets/a.js")).toEqual({ "max-keys": 1000, marker: "assets/a.js" });
  });

  test("content types by extension", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("apps.md")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeFor("llms.txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("schemas/agent.schema.json")).toBe("application/json");
    expect(contentTypeFor("sitemap.xml")).toBe("application/xml");
    expect(contentTypeFor("assets/app.abc.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("assets/style.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("assets/f.woff2")).toBe("font/woff2");
    expect(contentTypeFor("logo.png")).toBe("image/png");
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("favicon.ico")).toBe("image/x-icon");
    expect(contentTypeFor("x.unknown")).toBe("application/octet-stream");
  });

  test("cache control: hashed assets immutable, images a day, the rest revalidated", () => {
    expect(cacheControlFor("assets/app.abc.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("assets/logo.png")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("logo.png")).toBe("public, max-age=86400");
    expect(cacheControlFor("favicon.ico")).toBe("public, max-age=86400");
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("llms.txt")).toBe("no-cache");
  });

  test("uploads assets first and HTML last", () => {
    const order = uploadOrder([
      "index.html",
      "llms.txt",
      "assets/b.js",
      "a/b.html",
      "assets/a.css",
    ]);
    expect(order).toEqual(["assets/a.css", "assets/b.js", "llms.txt", "a/b.html", "index.html"]);
  });

  test("stale keys are bucket objects the dist lacks", () => {
    expect(staleKeys(["index.html", "old.html", "assets/old.js"], ["index.html"])).toEqual([
      "old.html",
      "assets/old.js",
    ]);
    expect(staleKeys([], ["index.html"])).toEqual([]);
  });

  test("an empty dist or one without index.html is never usable", () => {
    expect(() => assertDistUsable([])).toThrow("empty");
    expect(() => assertDistUsable(["llms.txt"])).toThrow("index.html");
    expect(() => assertDistUsable(["index.html"])).toThrow("llms.txt");
    expect(() => assertDistUsable(["index.html", "llms.txt"])).not.toThrow();
  });
});
