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

// A new Agent's first picture is read from the server bundle (the image has no `public/` or source
// tree to read it from). If the build stops inlining them, `decodeInlinedPicture` throws at the
// first Agent create; this fails the image before that.
test("the server bundle embeds all twenty-four Agent avatar pictures", async () => {
  const bundle = await Bun.file(".output/server/index.mjs").text();

  expect(bundle.match(/data:image\/webp;base64,UklGR/g)?.length ?? 0).toBeGreaterThanOrEqual(24);
});

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
