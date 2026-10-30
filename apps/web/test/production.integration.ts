import { expect, test } from "bun:test";

import {
  BUILT_SERVER_BOOT_MS,
  TEST_SLACK_MS,
  spawnBuiltServer,
  waitForHealth,
} from "./helpers/built-server";

// Run from the runtime image's /app directory, without source or workspace
// node_modules (the image build binds only this file and `helpers/built-server.ts`). A successful Vite build alone does not prove SSR can initialize.
test(
  "production image serves health and both deployment-specific installers",
  async () => {
    const server = spawnBuiltServer(
      { COFORGE_RELEASE_FEED_URL: "https://releases-staging.coforge.cn" },
      3000,
    );
    try {
      const health = await waitForHealth(server);
      expect(health?.status).toBe(200);
      expect(await health?.text()).toBe("ok");
      for (const [extension, anchor] of [
        ["sh", 'default_feed_url="https://releases-staging.coforge.cn"'],
        ["ps1", '$defaultFeedUrl = "https://releases-staging.coforge.cn"'],
      ]) {
        const response = await fetch(`http://127.0.0.1:3000/computer/install.${extension}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        const body = await response.text();
        expect(body).toContain(anchor);
        expect(body).not.toContain("https://releases.coforge.cn");
        if (extension === "sh") expect(body.startsWith("#!/bin/sh")).toBe(true);
      }
      // Agents without their own upload show these pictures; the image must ship them.
      const picture = await fetch("http://127.0.0.1:3000/agent-avatars/mascot-blue-4.webp", {
        signal: AbortSignal.timeout(1_000),
      });
      expect(picture.status).toBe(200);
      expect(picture.headers.get("content-type")).toBe("image/webp");
    } finally {
      server.process.kill();
      await server.process.exited;
      // This process receives fixture configuration only, never deployment secrets.
      const output = await server.output;
      if (output) console.error(output.slice(-8_192));
    }
  },
  BUILT_SERVER_BOOT_MS + TEST_SLACK_MS,
);

// `/health` and the installers do not load the application's routes; a page does. A route module
// that throws while it loads (a bundled entry point that runs, a missing export) answers every
// page with a 500 and nothing else, so the build has to be asked for a page.
test(
  "production server renders the public pages without an error",
  async () => {
    const server = spawnBuiltServer({});
    let output = "";
    try {
      expect((await waitForHealth(server))?.status).toBe(200);
      for (const locale of ["en", "zh-CN"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/${locale}`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status, locale).toBe(200);
        expect(response.headers.get("content-type"), locale).toContain("text/html");
        expect(await response.text(), locale).toContain("<html");
      }
    } finally {
      server.process.kill();
      await server.process.exited;
      output = await server.output;
      // The cause of a 500 is only in the server's output; show it with the failure.
      if (output.includes("error")) console.error(output.slice(-8_192));
    }
    // A thrown error is printed as `error: <message>` followed by its stack frames.
    expect(output).not.toMatch(/^error: /m);
    expect(output).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m);
  },
  BUILT_SERVER_BOOT_MS + TEST_SLACK_MS,
);

// Startup configuration is validated when the server starts, not when the first request loads the
// SSR entry (Nitro loads it lazily). A bad deployment must stop the process with no request sent,
// so the deploy's health wait fails at once instead of timing out against a listening server
// that answers every request with a 500.
test(
  "an invalid deployment configuration stops the server at boot, before any request",
  async () => {
    // An issuer without a signing keyset is a boot failure.
    const server = spawnBuiltServer({ COFORGE_OIDC_ISSUER: "https://coforge.example" });
    try {
      const exited = await Promise.race([
        server.process.exited,
        Bun.sleep(BUILT_SERVER_BOOT_MS).then(() => "running"),
      ]);
      expect(exited).not.toBe("running");
      expect(exited).not.toBe(0);
      expect(await server.output).toContain("COFORGE_OIDC");
    } finally {
      server.process.kill();
      await server.process.exited;
    }
  },
  BUILT_SERVER_BOOT_MS + TEST_SLACK_MS,
);

// Every server function call leaves a line with its id and time (task #348): even one that names
// no function, which fails before any runs.
test(
  "production server logs each server function call",
  async () => {
    const server = spawnBuiltServer({});
    try {
      expect((await waitForHealth(server))?.status).toBe(200);
      await fetch(`http://127.0.0.1:${server.port}/_serverFn/${"a".repeat(64)}`, {
        headers: {
          "x-request-id": "production-log-check",
          origin: `http://127.0.0.1:${server.port}`,
          "sec-fetch-site": "same-origin",
        },
        signal: AbortSignal.timeout(5_000),
      });
    } finally {
      server.process.kill();
      await server.process.exited;
    }
    const line = (await server.output)
      .split("\n")
      .find((entry) => entry.includes('"request_id":"production-log-check"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "server_fn.failed",
      fn: "a".repeat(64),
      method: "GET",
      duration_ms: expect.any(Number),
    });
  },
  BUILT_SERVER_BOOT_MS + TEST_SLACK_MS,
);
