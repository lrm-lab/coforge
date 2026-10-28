import { expect, test } from "bun:test";
import { KiroRuntimeAuthAdapter } from "@lrm/coforge-anvil/kiro";
import { ProcessTreeOwner } from "#src/platform/process-tree";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";
import type { RuntimeAuthLoginEvent } from "@lrm/coforge-anvil";

test.skipIf(process.platform === "win32")(
  "enterprise auth crosses the real PTY host port and verifies the native JSON plus Profile output",
  async () => {
    const events: RuntimeAuthLoginEvent[] = [];
    const adapter = new KiroRuntimeAuthAdapter({
      enterpriseLoginSupported: true,
      maskAccountLabel: () => "a***@example.com",
      spawn(args, cwd, terminal) {
        return runtimeAuthProcess(
          new ProcessTreeOwner().spawn(
            [
              Bun.which("bun")!,
              new URL("./fixtures/kiro-enterprise-auth.ts", import.meta.url).pathname,
              ...args,
            ],
            cwd,
            { PATH: Bun.env.PATH ?? "" },
            { terminal },
          ),
        );
      },
    });
    try {
      const result = await adapter.startLogin(
        {
          workingDirectory: import.meta.dir,
          timeoutMs: 2000,
          kiroIdentityCenter: {
            startUrl: "https://example.awsapps.com/start",
            region: "us-east-1",
          },
        },
        {
          onEvent: (e) => events.push(e),
          prompt: async () => {
            throw new Error("Unexpected manual code");
          },
        },
      );
      expect(result).toMatchObject({
        status: "logged_in",
        authStatus: {
          provider: "kiro",
          account: { maskedLabel: "a***@example.com" },
        },
      });
      expect(events).toEqual([
        {
          kind: "device_code",
          verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
          userCode: "ABCD-EFGH",
        },
      ]);
    } finally {
      await adapter.dispose();
    }
  },
  10_000,
);
