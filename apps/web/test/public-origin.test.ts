import { describe, expect, test } from "bun:test";

import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";

describe("publicOrigin", () => {
  test("prefers the origin the reverse proxy reports", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "staging.coforge.cn",
      },
    });

    expect(publicOrigin(request)).toBe("https://staging.coforge.cn");
  });

  test("reads only the first hop of a forwarded chain", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "coforge.cn, internal.example",
      },
    });

    expect(publicOrigin(request)).toBe("https://coforge.cn");
  });

  test("falls back to the request URL when the proxy sends neither header", () => {
    expect(publicOrigin(new Request("http://localhost:3000/"))).toBe("http://localhost:3000");
  });

  test("ignores a forwarded protocol that arrives without a forwarded host", () => {
    const request = new Request("http://localhost:3000/", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(publicOrigin(request)).toBe("http://localhost:3000");
  });

  test("keeps an explicit port that the proxy forwards", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "coforge.cn:8443",
      },
    });

    expect(publicOrigin(request)).toBe("https://coforge.cn:8443");
  });

  test("rejects a scheme that is not http or https", () => {
    // `new URL("file://evil.com").origin` is the literal string "null"; rendered into an
    // install command that becomes `curl -fsSL null/computer/install.sh | sh`.
    for (const scheme of ["file", "ftp", "ws", "data"]) {
      const request = new Request("http://staging.coforge.cn/", {
        headers: {
          "x-forwarded-proto": scheme,
          "x-forwarded-host": "evil.example",
        },
      });

      expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
    }
  });

  test("rejects a forwarded host carrying only a password", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": ":pw@evil.example",
      },
    });

    expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
  });

  test("rejects a forwarded host that smuggles a path", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "coforge.cn/evil",
      },
    });

    expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
  });
});

describe("clientAddress", () => {
  const from = (forwardedFor?: string) =>
    new Request("http://coforge.cn/", {
      headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    });

  test("is the hop the reverse proxy appended, not one the client wrote", () => {
    expect(clientAddress(from("198.51.100.9, 203.0.113.7"))).toBe("203.0.113.7");
    expect(clientAddress(from("203.0.113.7"))).toBe("203.0.113.7");
  });

  test("reads an IPv6 address", () => {
    expect(clientAddress(from("2001:db8::1"))).toBe("2001:db8::1");
  });

  test("is undefined without the header or with a last hop that is not an address", () => {
    expect(clientAddress(from())).toBeUndefined();
    expect(clientAddress(from(""))).toBeUndefined();
    expect(clientAddress(from("203.0.113.7, unknown"))).toBeUndefined();
    expect(clientAddress(from("203.0.113.7:4711"))).toBeUndefined();
    expect(clientAddress(from("203.0.113.999"))).toBeUndefined();
    expect(clientAddress(from("evil.example.com"))).toBeUndefined();
    expect(clientAddress(from("1.2"))).toBeUndefined();
    expect(clientAddress(from("0x7f.0.0.1"))).toBeUndefined();
    expect(clientAddress(from("[2001:db8::1]"))).toBeUndefined();
    expect(clientAddress(from("2001:db8::zz"))).toBeUndefined();
    expect(clientAddress(from("fe80::1%eth0"))).toBeUndefined();
  });
});
