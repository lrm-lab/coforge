import { expect, test } from "bun:test";
import { CliError } from "#src/errors";
import { OneShotAttachFailedError } from "#src/setup/one-shot-attach";
import { createSetup } from "./setup-fixture";

/** The one-shot attach's credential seam (task #417): `attach --one-shot`'s failure is the
 * answer — a 401 or a denied attach never silently falls back to the OAuth login. */
test("a one-shot attach failure never falls back to the OAuth login", async () => {
  let authenticateCalls = 0;
  const setup = createSetup({
    authenticate: {
      async authenticate() {
        authenticateCalls++;
        return { accessToken: "x", tokenType: "Bearer" };
      },
    },
    oneShotAttach: async () => {
      throw new CliError("ATTACH_DENIED", "Attach denied", "Try again");
    },
  });
  await expect(setup.run({ workspaceSlug: "workspace-a", oneShot: true })).rejects.toMatchObject({
    code: "ATTACH_DENIED",
  });
  expect(authenticateCalls).toBe(0);
});

test("a refusal on the approval page reaches the caller as ATTACH_DENIED", async () => {
  // Task #696, from the #417 acceptance: the attach knew the difference between a refusal, an
  // expiry and a timeout, and the setup wrapper collapsed all three into SETUP_ATTACH_FAILED —
  // so a person who clicked "deny" was told to check their network and try again.
  const setup = createSetup({
    oneShotAttach: async () => {
      throw new OneShotAttachFailedError(
        "ATTACH_DENIED",
        "The attach was refused on the approval page.",
      );
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a", oneShot: true })).rejects.toMatchObject({
    code: "ATTACH_DENIED",
  });
});

test("a one-shot's AUTH_LOGIN_EXPIRED never re-authenticates against the OAuth login", async () => {
  // The one-shot token has no login to fall back to: an expired answer is the attach failing,
  // never a login to retry (task #417).
  let authenticateCalls = 0;
  const setup = createSetup({
    authenticate: {
      async authenticate() {
        authenticateCalls++;
        return { accessToken: "x", tokenType: "Bearer" };
      },
    },
    oneShotAttach: async () => {
      throw new CliError("AUTH_LOGIN_EXPIRED", "Login expired", "Log in again");
    },
  });
  await expect(setup.run({ workspaceSlug: "workspace-a", oneShot: true })).rejects.toMatchObject({
    code: "AUTH_LOGIN_EXPIRED",
  });
  expect(authenticateCalls).toBe(0);
});
