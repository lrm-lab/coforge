import { expect, test } from "bun:test";

import { readBrowserSession } from "#src/server/auth/browser-login.server";
import {
  authorizeDesktopRequest,
  decideDesktopAccess,
  desktopComputerId,
} from "#src/server/computers/desktop-proxy-auth.server";

const sessionSecret = "session-secret-at-least-32-characters";
const computerId = "01a15829-2da5-740c-848c-c287bf1e8ab6";

test("a desktop path names its computer and nothing else", () => {
  expect(desktopComputerId(`/desktop/${computerId}/`)).toBe(computerId);
  expect(desktopComputerId(`/desktop/${computerId}/agent-1/websockify`)).toBe(computerId);
  expect(desktopComputerId(`/desktop/${computerId}/?token=1`)).toBe(computerId);
  expect(desktopComputerId("/desktop")).toBeUndefined();
  expect(desktopComputerId("/desktop/../etc/passwd")).toBeUndefined();
  expect(desktopComputerId("/api/internal/desktop-authorize")).toBeUndefined();
});

test("only the signed-in owner of that cloud computer is allowed through", () => {
  expect(decideDesktopAccess({ computerId, signedIn: true, ownsCloudComputer: true })).toBe(
    "allow",
  );
  expect(decideDesktopAccess({ computerId, signedIn: false, ownsCloudComputer: false })).toBe(
    "unauthenticated",
  );
  expect(decideDesktopAccess({ computerId, signedIn: true, ownsCloudComputer: false })).toBe(
    "forbidden",
  );
  expect(
    decideDesktopAccess({ computerId: undefined, signedIn: false, ownsCloudComputer: false }),
  ).toBe("forbidden");
});

test("the proxy decision reads the session and the ownership answer", async () => {
  const secret = sessionSecret;
  const cookie = sessionCookie();
  expect(readBrowserSession({ sessionSecret: secret, cookieHeader: cookie })?.id).toBe("user-1");

  const owned = await authorizeDesktopRequest({
    desktopPath: `/desktop/${computerId}/agent-1/`,
    cookieHeader: cookie,
    sessionSecret: secret,
    ownsCloudComputer: async () => true,
  });
  expect(owned.status).toBe(200);

  const someoneElses = await authorizeDesktopRequest({
    desktopPath: `/desktop/${computerId}/`,
    cookieHeader: cookie,
    sessionSecret: secret,
    ownsCloudComputer: async () => false,
  });
  expect(someoneElses.status).toBe(403);

  const signedOut = await authorizeDesktopRequest({
    desktopPath: `/desktop/${computerId}/`,
    cookieHeader: "",
    sessionSecret: secret,
    ownsCloudComputer: async () => true,
  });
  expect(signedOut.status).toBe(401);
});

function sessionCookie(): string {
  const body = Buffer.from(
    JSON.stringify({
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      authingSub: "authing-user-1",
      username: "ada",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signature = new Bun.CryptoHasher("sha256", sessionSecret)
    .update(`session.${body}`)
    .digest("base64url");
  return `coforge_session=${body}.${signature}`;
}
