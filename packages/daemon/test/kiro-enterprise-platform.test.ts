import { expect, test } from "bun:test";
import { KiroRuntimeAuthAdapter } from "@lrm/coforge-anvil/kiro";
import {
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  RUNTIME_AUTH_CAPABILITY,
} from "@lrm/coforge-sdk/internal";
import { readyCapabilities } from "#src/daemon-runtime/ready-capabilities";
import { createKiroAuthHost } from "#src/code-agent/kiro/auth-host";

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`${platform} Kiro enterprise capability matches its host support`, async () => {
    const host = createKiroAuthHost(platform);
    const supported = platform !== "win32";
    expect(host.enterpriseLoginSupported).toBe(supported);
    expect(
      readyCapabilities(false, true, platform).includes(KIRO_IDENTITY_CENTER_AUTH_CAPABILITY),
    ).toBe(supported);
    expect(readyCapabilities(false, true, platform)).toContain(RUNTIME_AUTH_CAPABILITY);
    if (supported) return;
    let spawns = 0;
    const adapter = new KiroRuntimeAuthAdapter({
      ...host,
      spawn() {
        spawns++;
        throw new Error("must refuse before spawn");
      },
    });
    expect(
      await adapter.startLogin(
        {
          workingDirectory: "/fixture",
          kiroIdentityCenter: {
            startUrl: "https://example.awsapps.com/start",
            region: "us-east-1",
          },
        },
        {
          onEvent() {},
          async prompt() {
            throw new Error("unexpected prompt");
          },
        },
      ),
    ).toEqual({ status: "unsupported", reason: "unsupported_installation" });
    expect(spawns).toBe(0);
  });
}
