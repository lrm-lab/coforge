import { describe, expect, test } from "bun:test";
import {
  resolveLaunchIdentity,
  type LaunchIdentityInput,
  type SessionReference,
} from "#src/daemon-runtime/launch-identity";

const ids = () => {
  let next = 0;
  return () => `minted-${++next}`;
};
const resolve = (input: Partial<LaunchIdentityInput>) =>
  resolveLaunchIdentity({
    request: {},
    provider: "codex",
    previous: undefined,
    serverLaunch: undefined,
    newId: ids(),
    ...input,
  });
const previous: SessionReference = {
  requestId: "previous-request",
  provider: "codex",
  sessionId: "previous-session",
  sessionMode: "resume",
  launchId: "previous-launch",
  controlEpoch: 3,
};

describe("resolveLaunchIdentity", () => {
  test("a first unmanaged launch mints its request and launch ids and has no managed scope", () => {
    expect(resolve({})).toEqual({
      requestId: "minted-1",
      reference: {
        requestId: "minted-1",
        provider: "codex",
        sessionId: undefined,
        sessionMode: undefined,
        launchId: undefined,
        controlEpoch: undefined,
      },
      previousLaunchId: undefined,
      launchId: "minted-2",
      reused: false,
      managedScope: undefined,
    });
  });

  test("a server Start uses its control identity as the launch and the managed scope", () => {
    const resolved = resolve({
      request: { requestId: "start", control: { controlEpoch: 7, launchId: "control-launch" } },
    });
    expect(resolved.launchId).toBe("control-launch");
    expect(resolved.reused).toBe(false);
    expect(resolved.managedScope).toEqual({
      controlEpoch: 7,
      requestId: "start",
      launchId: "control-launch",
    });
    expect(resolved.reference.controlEpoch).toBe(7);
  });

  test("a wake reuses the remembered server launch identity and resends its scope", () => {
    const serverLaunch = { requestId: "remembered", controlEpoch: 5, launchId: "server-launch" };
    const resolved = resolve({ previous, serverLaunch });
    expect(resolved.launchId).toBe("server-launch");
    expect(resolved.reused).toBe(true);
    expect(resolved.managedScope).toEqual(serverLaunch);
  });

  test("the same provider and request continue the previous session reference", () => {
    const resolved = resolve({ previous });
    expect(resolved.requestId).toBe("previous-request");
    expect(resolved.reference).toMatchObject({
      requestId: "previous-request",
      sessionId: "previous-session",
      sessionMode: "resume",
      launchId: "previous-launch",
    });
    // The hand-over names the launch it replaces.
    expect(resolved.previousLaunchId).toBe("previous-launch");
  });

  test("another provider or another request starts over, keeping only what the request names", () => {
    for (const input of [
      { previous, provider: "claude-code" as const },
      { previous, request: { requestId: "other" } },
    ]) {
      const { reference } = resolve(input);
      expect(reference.sessionId).toBeUndefined();
      expect(reference.sessionMode).toBeUndefined();
      expect(reference.launchId).toBeUndefined();
    }
    expect(
      resolve({ previous, request: { requestId: "other", sessionId: "s", sessionMode: "create" } })
        .reference,
    ).toMatchObject({ requestId: "other", sessionId: "s", sessionMode: "create" });
  });

  test("omits the hand-over when the reused launch's identity did not change", () => {
    const serverLaunch = {
      requestId: "previous-request",
      controlEpoch: 3,
      launchId: "previous-launch",
    };
    expect(resolve({ previous, serverLaunch }).previousLaunchId).toBeUndefined();
    expect(
      resolve({
        previous,
        request: { requestId: "previous-request", control: { launchId: "previous-launch" } },
      }).previousLaunchId,
    ).toBeUndefined();
  });
});
