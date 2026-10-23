import { afterEach, expect, test } from "bun:test";

import {
  EgressProxyConfiguredError,
  NonPublicAddressError,
  OUTBOUND_MAX_ADDRESSES,
  OutboundEgress,
  UnsupportedEgressSchemeError,
} from "#src/server/egress/outbound-egress.server";

const public4 = async () => [{ address: "203.0.114.8", family: 4 as const }];
const familyOf = (address: string) => (address.includes(":") ? (6 as const) : (4 as const));

test("resolves only to public addresses, whatever the caller", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::8"]) {
    const egress = new OutboundEgress({
      resolve: async () => [{ address, family: familyOf(address) }],
    });
    await expect(egress.resolveTarget("https://hooks.example/x")).rejects.toBeInstanceOf(
      NonPublicAddressError,
    );
  }
});

test("refuses the IANA special-purpose ranges that are not globally reachable", async () => {
  for (const address of [
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "192.0.0.8",
    "2620:4f:8000::1",
    "2001:db8::1",
  ]) {
    const egress = new OutboundEgress({
      resolve: async () => [{ address, family: familyOf(address) }],
    });
    await expect(egress.resolveTarget("https://hooks.example/x")).rejects.toBeInstanceOf(
      NonPublicAddressError,
    );
  }
  for (const address of ["8.8.8.8", "192.31.195.1", "2606:4700::1111", "2620:4f:7fff::1"]) {
    const egress = new OutboundEgress({
      resolve: async () => [{ address, family: familyOf(address) }],
    });
    expect((await egress.resolveTarget("https://hooks.example/x")).address).toBe(address);
  }
});

test("a single private answer among public ones refuses the hostname", async () => {
  const egress = new OutboundEgress({
    resolve: async () => [
      { address: "203.0.114.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
  });
  await expect(egress.resolveTarget("https://hooks.example/x")).rejects.toBeInstanceOf(
    NonPublicAddressError,
  );
});

test("looks up an IPv6 literal without its brackets and rejects a private one", async () => {
  const seen: string[] = [];
  const egress = new OutboundEgress({
    resolve: async (hostname) => {
      seen.push(hostname);
      return [{ address: hostname, family: 6 }];
    },
  });
  await expect(egress.resolveTarget("https://[fd00::8]/x")).rejects.toBeInstanceOf(
    NonPublicAddressError,
  );
  expect(seen).toEqual(["fd00::8"]);
});

test("only https: http and other schemes are refused, loopback included", async () => {
  const egress = new OutboundEgress({ resolve: public4 });
  for (const url of ["ftp://hooks.example/x", "http://hooks.example/x", "http://127.0.0.1/x"]) {
    await expect(egress.resolveTarget(url)).rejects.toBeInstanceOf(UnsupportedEgressSchemeError);
  }
  const target = await egress.resolveTarget("https://hooks.example/x");
  await expect(
    egress.send("http://hooks.example/x", { method: "POST" }, target, 1_000),
  ).rejects.toBeInstanceOf(UnsupportedEgressSchemeError);
});

test("resolves at most a few distinct addresses, in the resolver's order", async () => {
  const egress = new OutboundEgress({
    resolve: async () => [
      ...Array.from({ length: 6 }, (_, index) => ({
        address: `203.0.114.${index + 1}`,
        family: 4 as const,
      })),
      { address: "203.0.114.1", family: 4 as const },
    ],
  });
  const targets = await egress.resolveTargets("https://hooks.example/x");
  expect(targets.map((target) => target.address)).toEqual(
    ["203.0.114.1", "203.0.114.2", "203.0.114.3"].slice(0, OUTBOUND_MAX_ADDRESSES),
  );
});

test("a request is pinned to the checked address, verified against the real hostname", async () => {
  const seen: { url: string; init: BunFetchRequestInit }[] = [];
  const egress = new OutboundEgress({
    resolve: public4,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });
  const target = await egress.resolveTarget("https://hooks.example:8443/hook?a=1");
  expect(
    await egress.send(
      "https://hooks.example:8443/hook?a=1",
      { method: "POST", body: "{}" },
      target,
      5_000,
    ),
  ).toEqual({ status: 204 });
  expect(seen[0]!.url).toBe("https://203.0.114.8:8443/hook?a=1");
  expect(seen[0]!.init).toMatchObject({
    method: "POST",
    redirect: "manual",
    keepalive: false,
    tls: { serverName: "hooks.example" },
    headers: { Host: "hooks.example:8443" },
  });
});

test("never follows a redirect and reports its status", async () => {
  const egress = new OutboundEgress({
    resolve: public4,
    fetch: async () =>
      new Response(null, { status: 302, headers: { location: "https://10.0.0.8/" } }),
  });
  expect(await egress.sendToAny("https://hooks.example/x", { method: "POST" }, 5_000)).toEqual({
    status: 302,
  });
});

test("tries the next validated address when a connection fails, not when a status arrives", async () => {
  const attempted: string[] = [];
  const egress = new OutboundEgress({
    resolve: async () => [
      { address: "203.0.114.1", family: 4 },
      { address: "203.0.114.2", family: 4 },
      { address: "203.0.114.3", family: 4 },
    ],
    fetch: async (url) => {
      attempted.push(new URL(url).hostname);
      if (url.includes("203.0.114.3")) return new Response(null, { status: 500 });
      throw new Error("connect failed");
    },
  });
  expect(await egress.sendToAny("https://hooks.example/x", { method: "POST" }, 5_000)).toEqual({
    status: 500,
  });
  expect(attempted).toEqual(["203.0.114.1", "203.0.114.2", "203.0.114.3"]);

  const failing = new OutboundEgress({
    resolve: async () => [
      { address: "203.0.114.1", family: 4 },
      { address: "203.0.114.2", family: 4 },
    ],
    fetch: async () => {
      throw new Error("connect failed");
    },
  });
  await expect(
    failing.sendToAny("https://hooks.example/x", { method: "POST" }, 5_000),
  ).rejects.toThrow("connect failed");
});

test("a timeout ends the attempts instead of trying the next address", async () => {
  let calls = 0;
  const egress = new OutboundEgress({
    resolve: async () => [
      { address: "203.0.114.1", family: 4 },
      { address: "203.0.114.2", family: 4 },
    ],
    fetch: async () => {
      calls++;
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });
  await expect(
    egress.sendToAny("https://hooks.example/x", { method: "POST" }, 5_000),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls).toBe(1);
});

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
const saved = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of PROXY_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("the default fetch refuses to run while a proxy is configured, so pinning cannot be bypassed", async () => {
  for (const name of PROXY_VARIABLES) {
    for (const other of PROXY_VARIABLES) delete process.env[other];
    process.env[name] = "http://127.0.0.1:9";
    const egress = new OutboundEgress({ resolve: public4 });
    const error = await egress
      .sendToAny("https://hooks.example/x", { method: "POST" }, 1_000)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EgressProxyConfiguredError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain("127.0.0.1");
  }
});
