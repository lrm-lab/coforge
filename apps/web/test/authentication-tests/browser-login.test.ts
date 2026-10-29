import { expect, test } from "bun:test";

import {
  completeBrowserLogin,
  sessionEndingCookie,
  readBrowserSession,
  type InternalUserResolver,
} from "#src/server/auth/browser-login.server";

const sessionSecret = "test-session-secret-at-least-32-characters";

type AuthingProfile = {
  sub: string;
  email?: string;
  phone_number?: string;
  phone?: string;
  phone_number_verified?: boolean;
  phone_verified?: boolean;
  name?: string;
  nickname?: string;
  preferred_username?: string;
};

function fakeAuthing(user: AuthingProfile) {
  return {
    async fetchUserInfo(accessToken: string) {
      if (accessToken !== "authing-access") throw new Error("invalid access token");
      return user;
    },
  };
}

test("completeBrowserLogin creates a CoForge user session from Authing", async () => {
  const completed = await signIn({
    sub: "authing-user-1",
    email: "ada@example.com",
    name: "Ada",
  });

  expect(completed.user.email).toBe("ada@example.com");
  expect(completed.user.name).toBe("Ada");
  expect(completed.user.authingSub).toBe("authing-user-1");
  expect(completed.user.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(completed.sessionCookie).toContain("coforge_session=");
  expect(completed.sessionCookie).toContain("HttpOnly");
  expect(completed.sessionCookie).toContain("SameSite=Lax");
  expect(completed.sessionCookie).not.toContain("Domain=");
  expect(completed.sessionCookie).not.toContain("Secure");
  expect(completed.sessionCookie).toContain("Path=/;");

  const user = readBrowserSession({
    sessionSecret,
    cookieHeader: cookieHeader(completed.sessionCookie),
  });
  expect(user).toEqual(completed.user);
  expect(user).not.toHaveProperty("accessToken");
});

test("the same Authing subject maps to the same CoForge user", async () => {
  const first = await loginAs("authing-user-1", "ada@example.com");
  const second = await loginAs("authing-user-1", "ada@example.com");
  expect(first.user.id).toBe(second.user.id);
});

test("passes Authing preferred_username to first-identity resolution and stores username", async () => {
  let profile: unknown;
  const completed = await signIn(
    {
      sub: "provider-subject-not-a-username",
      email: "ada@example.com",
      preferred_username: "ada",
    },
    async (input) => {
      profile = input;
      return {
        id: "00000000-0000-5000-8000-000000000002",
        username: "ada",
        displayName: "Ada",
        welcomedAt: null,
      };
    },
  );
  expect(profile).toEqual({
    provider: "authing",
    subject: "provider-subject-not-a-username",
    email: "ada@example.com",
    preferredUsername: "ada",
  });
  expect(completed.user.username).toBe("ada");
  expect(
    readBrowserSession({
      sessionSecret,
      cookieHeader: cookieHeader(completed.sessionCookie),
    }),
  ).toMatchObject({ username: "ada" });
});

test("the profile's name and nickname reach user resolution, so a username can be derived from them", async () => {
  let resolved: unknown;
  await signIn({ sub: "s", name: " Ada Lovelace ", nickname: "Ace" }, async (input) => {
    resolved = input;
    return {
      id: "00000000-0000-5000-8000-000000000004",
      username: "ada-lovelace",
      displayName: "Ada Lovelace",
      welcomedAt: null,
    };
  });

  expect(resolved).toEqual({
    provider: "authing",
    subject: "s",
    email: null,
    name: "Ada Lovelace",
    nickname: "Ace",
  });
});

test("completeBrowserLogin signs in an Authing account that has no email", async () => {
  const completed = await signIn({ sub: "authing-phone-user", name: "Ada" });

  expect(completed.user.email).toBeNull();
  expect(completed.user.name).toBe("Ada");
  expect(completed.user.authingSub).toBe("authing-phone-user");
  expect(completed.sessionCookie).toContain("coforge_session=");
  // The session keeps the missing email as an explicit null, not as a key that is gone.
  expect(
    readBrowserSession({ sessionSecret, cookieHeader: cookieHeader(completed.sessionCookie) }),
  ).toEqual({ ...completed.user, email: null });
});

test("an account with no email reaches user resolution with a null email, and no username hint it did not send", async () => {
  let resolved: unknown;
  await signIn({ sub: "authing-phone-user" }, async (input) => {
    resolved = input;
    return {
      id: "00000000-0000-5000-8000-000000000003",
      username: "user-0a1b2c3d",
      displayName: "Unnamed",
      welcomedAt: null,
    };
  });

  expect(resolved).toEqual({ provider: "authing", subject: "authing-phone-user", email: null });
});

test("the profile's verified phone number reaches user resolution as E.164, from either claim", async () => {
  const resolved: unknown[] = [];
  const resolveUser: InternalUserResolver = async (input) => {
    resolved.push(input);
    return {
      id: "00000000-0000-5000-8000-000000000005",
      username: "user-0a1b2c3d",
      displayName: "Unnamed",
      welcomedAt: null,
    };
  };
  await signIn(
    { sub: "phone-claim", phone_number: " 138 0013 8000 ", phone_number_verified: true },
    resolveUser,
  );
  await signIn({ sub: "legacy-claim", phone: "+8613800138000", phone_verified: true }, resolveUser);

  expect(resolved).toEqual([
    { provider: "authing", subject: "phone-claim", email: null, phone: "+8613800138000" },
    { provider: "authing", subject: "legacy-claim", email: null, phone: "+8613800138000" },
  ]);
});

test("an unverified phone number never reaches user resolution, so it can never match", async () => {
  const resolved: unknown[] = [];
  const resolveUser: InternalUserResolver = async (input) => {
    resolved.push(input);
    return {
      id: "00000000-0000-5000-8000-000000000007",
      username: "user-0a1b2c3d",
      displayName: "Unnamed",
      welcomedAt: null,
    };
  };
  await signIn(
    { sub: "unverified", phone_number: "13800138000", phone_number_verified: false },
    resolveUser,
  );
  await signIn({ sub: "no-claim", phone_number: "13800138000" }, resolveUser);

  expect(resolved).toEqual([
    { provider: "authing", subject: "unverified", email: null },
    { provider: "authing", subject: "no-claim", email: null },
  ]);
});

test("a phone number this platform cannot use reaches user resolution as no phone at all", async () => {
  const resolved: unknown[] = [];
  const resolveUser: InternalUserResolver = async (input) => {
    resolved.push(input);
    return {
      id: "00000000-0000-5000-8000-000000000006",
      username: "user-0a1b2c3d",
      displayName: "Unnamed",
      welcomedAt: null,
    };
  };
  await signIn(
    { sub: "foreign", phone_number: "+14155550100", phone_number_verified: true },
    resolveUser,
  );
  await signIn({ sub: "empty", phone_number: "", phone_number_verified: true }, resolveUser);

  expect(resolved).toEqual([
    { provider: "authing", subject: "foreign", email: null },
    { provider: "authing", subject: "empty", email: null },
  ]);
});

// The session's `name` is what the provider reported (its name, else its nickname), kept only to
// start the first-sign-in name field with. It is never a stand-in for a person's name: nothing is
// derived from an email or the username.

test("the session name is the provider's name, trimmed, else its nickname, else nothing", async () => {
  const resolveUser = async () => ({
    id: "00000000-0000-5000-8000-000000000003",
    username: "user-0a1b2c3d",
    displayName: "Unnamed",
    welcomedAt: null,
  });
  const nameOf = async (profile: Omit<AuthingProfile, "sub">) =>
    (await signIn({ sub: "s", ...profile }, resolveUser)).user.name;

  expect(await nameOf({ name: " Ada ", nickname: "Ace" })).toBe("Ada");
  expect(await nameOf({ nickname: " Ace " })).toBe("Ace");
  expect(await nameOf({ name: "  ", nickname: "Ace" })).toBe("Ace");
  expect(await nameOf({ name: "  ", nickname: "" })).toBe("");
  // An email is not a name, and neither is the username the account was given.
  expect(await nameOf({ email: "Grace@Example.com" })).toBe("");
  expect(await nameOf({ preferred_username: "grace" })).toBe("");
});

test("sign-in reports the stored display name, and whether first sign-in is done", async () => {
  const resolved = (displayName: string, welcomedAt: Date | null) => async () => ({
    id: "00000000-0000-5000-8000-000000000003",
    username: "ada",
    displayName,
    welcomedAt,
  });

  expect(await signIn({ sub: "s", name: "Ada" }, resolved("Ada", null))).toMatchObject({
    displayName: "Ada",
    welcomed: false,
  });
  // The provider's name is not the stored one: the stored one is what decides.
  expect(
    await signIn({ sub: "s" }, resolved("Ada Lovelace", new Date("2026-10-01T00:00:00Z"))),
  ).toMatchObject({ displayName: "Ada Lovelace", welcomed: true });
});

test("an email is trimmed and lower-cased, and a blank one counts as none", async () => {
  const padded = await signIn({ sub: "s", email: "  Ada@Example.COM ", name: "Ada" });
  expect(padded.user.email).toBe("ada@example.com");

  const blank = await signIn({ sub: "s", email: "   ", name: "Ada" });
  expect(blank.user.email).toBeNull();
});

test("readBrowserSession returns null for a missing or tampered cookie", () => {
  expect(readBrowserSession({ sessionSecret, cookieHeader: "" })).toBeNull();
  expect(
    readBrowserSession({
      sessionSecret,
      cookieHeader: "coforge_session=not-a-real-session",
    }),
  ).toBeNull();
});

async function loginAs(sub: string, email: string) {
  return signIn({ sub, email, name: "Ada" });
}

async function signIn(profile: AuthingProfile, resolveUser?: InternalUserResolver) {
  return completeBrowserLogin({
    sessionSecret,
    tokens: { accessToken: "authing-access" },
    authing: fakeAuthing(profile),
    secure: false,
    ...(resolveUser ? { resolveUser } : {}),
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

/** A session cookie for `fields` laid over a valid session, signed the way this module signs one. */
function sessionCookieWith(fields: Record<string, unknown>): string {
  const body = Buffer.from(
    JSON.stringify({
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      authingSub: "authing-user-1",
      username: "ada",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...fields,
    }),
  ).toString("base64url");
  const signature = new Bun.CryptoHasher("sha256", sessionSecret)
    .update(`session.${body}`)
    .digest("base64url");
  return `coforge_session=${body}.${signature}`;
}

test("a session cookie signed in with an email, or with none, still reads as that session", () => {
  const read = (fields: Record<string, unknown>) =>
    readBrowserSession({ sessionSecret, cookieHeader: sessionCookieWith(fields) });

  // Cookies made before an email became optional carry a string, and stay valid.
  expect(read({})).toMatchObject({ id: "user-1", email: "ada@example.com" });
  expect(read({ email: null })).toMatchObject({ id: "user-1", email: null });
  // Anything else in the email's place is not a session this module wrote.
  expect(read({ email: 42 })).toBeNull();
  expect(read({ email: undefined })).toBeNull();
});

test("only a signature made for a session reads as a session", () => {
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
  const signedOver = (input: string) =>
    new Bun.CryptoHasher("sha256", sessionSecret).update(input).digest("base64url");
  const read = (value: string) =>
    readBrowserSession({ sessionSecret, cookieHeader: `coforge_session=${value}` });

  expect(read(`${body}.${signedOver(`session.${body}`)}`)).toMatchObject({ id: "user-1" });
  // Signed over the body alone, or for another kind of cookie.
  expect(read(`${body}.${signedOver(body)}`)).toBeNull();
  expect(read(`${body}.${signedOver(`sign-in-requested.${body}`)}`)).toBeNull();
  expect(read(`${body}.${signedOver(`session.${body}`)}.extra`)).toBeNull();
});

test("a session holds no Authing token, and signing out expires the cookie", async () => {
  const completed = await signIn({ sub: "authing-user-1", email: "ada@example.com", name: "Ada" });
  const [, payload = ""] = /^coforge_session=([^.;]+)/.exec(completed.sessionCookie) ?? [];
  expect(Buffer.from(payload, "base64url").toString()).not.toContain("authing-access");

  const ended = sessionEndingCookie(true);
  expect(ended).toStartWith("coforge_session=;");
  expect(ended).toContain("Max-Age=0");
  expect(ended).toContain("HttpOnly");
  expect(ended).toContain("Secure");
  expect(sessionEndingCookie(false)).not.toContain("Secure");
});
