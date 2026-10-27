import { createHash, randomBytes } from "node:crypto";

/**
 * The part of Authing the Web server calls, served over HTTPS for the browser e2es of real sign-in
 * (`e2e-sign-in-harness.ts` starts it), with the people it knows. Not a test file.
 */

export type Person = {
  sub: string;
  email?: string;
  /** The email the person types to sign in, when it is not the `email` the profile reports (an
   * account made with a phone number can sign in with an email its profile does not report). */
  signInEmail?: string;
  /** The mainland China mobile number (eleven digits, no country code) the person signs in with
   * by code, and the profile reports. */
  phone?: string;
  name?: string;
  nickname?: string;
  refused?: true;
};

export const appId = "e2e-sign-in-app";
export const appSecret = "e2e-sign-in-app-secret";

/** The password every test person signs in with. */
export const personPassword = "e2e-correct-horse-battery";

/** What a test person types into the email field. */
export function signInEmailOf(person: Person): string {
  const email = person.signInEmail ?? person.email;
  if (!email) throw new Error(`${person.sub} has no email to sign in with`);
  return email;
}

/** A verification code the fake sent, as Authing sent it: by SMS to `+<country code><number>`, or
 * by email to the address, for signing in or for resetting a password. */
export type SentCode = {
  channel: "sms" | "email";
  destination: string;
  code: string;
  purpose: "login" | "reset_password";
};

/** The `sub` the fake gives the person a code sign-in makes for `destination` (`+86<phone>` or
 * the email), so a test can find and remove the account. */
export function registeredSubFor(destination: string): string {
  return `e2e-sign-in-registered-${createHash("sha256").update(destination).digest("hex").slice(0, 12)}`;
}

/** Where a fake send is refused: Authing's own throttle (its `statusCode` 429), and an outage. */
export const throttledDestination = "e2e-throttled@coforge.test";
export const unsendableDestination = "e2e-unsendable@coforge.test";

/** The one password the fake's policy refuses, besides any shorter than eight characters. */
export const refusedPassword = "e2e-refused-password";

/**
 * The part of Authing the Web server talks to. `POST /api/v3/signin` checks the app id header, the
 * client credentials and the `PASSWORD` connection, then the email and password of a test person,
 * or the `PASSCODE` connection, then a code the fake sent to the phone number or email (a code
 * works once; with `autoRegister` an unknown destination becomes a new person with a fresh `sub`,
 * which `registered` lists). `POST /api/v3/send-sms` and `send-email` send codes, which `sentCodes`
 * lists. A reset-password code is sent only to a destination an account has (an unknown one is
 * refused, and `refusedResetSends` lists it); `verify-reset-password-request` trades such a code
 * for a single-use token and `reset-password` sets the password with it (`resets` lists them), and
 * from then on that password, not `personPassword`, signs the account in. A refusal is Authing's own shape (a non-200 `statusCode` in the JSON body, HTTP 200).
 * `GET /oidc/me` answers a token's profile and `POST /oidc/token/revocation` records what was
 * revoked. With `github`, `POST /api/v3/signin-by-mobile` exchanges the code GitHub sent the
 * browser back with, for the person `github.consume` says it was issued to: one of `people`, else
 * a new person made on first use.
 */
export function startFakeAuthing<Key extends string>(input: {
  people: Record<Key, Person>;
  tls: { cert: string; key: string };
  github?: { connection: string; consume(code: string): Person | undefined };
}) {
  const { people, tls, github } = input;
  const accessTokens = new Map<string, { key: Key | null; profile: Person }>();
  /** The sign-in requests the Web server sent, as Authing received them (never the password or
   * the code): whose they were and the client address the Web server passed on, if it did. */
  const signIns: {
    person: Key | null;
    connection: string;
    clientIp?: string;
  }[] = [];
  /** The tokens the Web server revoked, and whose they were. */
  const revoked: { token: string; person: Key | undefined }[] = [];
  /** The codes sent, oldest first. */
  const sentCodes: SentCode[] = [];
  /** The accounts a code sign-in made (`autoRegister`). */
  const registered: Person[] = [];
  const codes = new Map<string, string>();
  /** The destinations a reset code was refused for, because no account has them. */
  const refusedResetSends: { channel: SentCode["channel"]; destination: string }[] = [];
  /** The password resets that completed: whose account, by its `sub`. */
  const resets: { sub: string }[] = [];
  /** The passwords set by a reset, by account `sub`; the others have `personPassword`. */
  const passwords = new Map<string, string>();
  /** The tokens `verify-reset-password-request` issued, by the account's `sub`; each works once. */
  const resetTokens = new Map<string, string>();

  const refusal = (statusCode: number, message: string) =>
    Response.json({ statusCode, apiCode: 2333, message });

  /** A code Authing might send: six digits, never `000000`, which the e2es type as a wrong one. */
  const nextCode = () => String(100_000 + (((sentCodes.length + 1) * 7_919) % 900_000));

  /** The account that has `destination` (`+86<phone>`, or an email): a person, or one a code
   * sign-in made. */
  function accountOf(destination: string): { key?: Key; profile: Person } | undefined {
    const key = (Object.keys(people) as Key[]).find((candidate) => {
      const person = people[candidate];
      return (
        destination === person.email ||
        destination === person.signInEmail ||
        (person.phone !== undefined && destination === `+86${person.phone}`)
      );
    });
    if (key) return { key, profile: people[key] };
    const profile = registered.find(
      (person) => destination === person.email || destination === `+86${person.phone}`,
    );
    return profile ? { profile } : undefined;
  }

  function send(
    channel: SentCode["channel"],
    destination: string,
    purpose: SentCode["purpose"] = "login",
  ) {
    if (destination === throttledDestination) return refusal(429, "requests are too frequent");
    if (destination === unsendableDestination) return refusal(500, "send failed");
    if (purpose === "reset_password" && !accountOf(destination)) {
      refusedResetSends.push({ channel, destination });
      return refusal(404, "no such user");
    }
    const code = nextCode();
    codes.set(`${purpose}:${destination}`, code);
    sentCodes.push({ channel, destination, code, purpose });
    return Response.json({ statusCode: 200, message: "ok" });
  }

  function issueTokens(key: Key | undefined, profile: Person, scope: string | undefined) {
    const accessToken = randomBytes(16).toString("base64url");
    accessTokens.set(accessToken, { key: key ?? null, profile });
    return Response.json({
      statusCode: 200,
      message: "ok",
      data: {
        access_token: accessToken,
        id_token: `id-${profile.sub}`,
        token_type: "Bearer",
        expire_in: 3600,
        scope: scope ?? "",
      },
    });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        (url.pathname === "/api/v3/send-sms" || url.pathname === "/api/v3/send-email") &&
        request.method === "POST"
      ) {
        const body = (await request.json().catch(() => null)) as {
          channel?: string;
          phoneNumber?: string;
          phoneCountryCode?: string;
          email?: string;
        } | null;
        const purpose =
          body?.channel === "CHANNEL_LOGIN"
            ? "login"
            : body?.channel === "CHANNEL_RESET_PASSWORD"
              ? "reset_password"
              : undefined;
        if (request.headers.get("x-authing-app-id") !== appId || !purpose)
          return refusal(400, "invalid request");
        if (url.pathname === "/api/v3/send-sms") {
          if (!body?.phoneNumber || body.phoneCountryCode !== "+86")
            return refusal(400, "invalid phone");
          return send("sms", `${body.phoneCountryCode}${body.phoneNumber}`, purpose);
        }
        return body?.email ? send("email", body.email, purpose) : refusal(400, "invalid email");
      }
      if (url.pathname === "/api/v3/verify-reset-password-request" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          verifyMethod?: string;
          phonePassCodePayload?: {
            phoneNumber?: string;
            phoneCountryCode?: string;
            passCode?: string;
          };
          emailPassCodePayload?: { email?: string; passCode?: string };
        } | null;
        if (request.headers.get("x-authing-app-id") !== appId) return refusal(401, "invalid app");
        const phone = body?.phonePassCodePayload;
        const email = body?.emailPassCodePayload;
        const destination =
          body?.verifyMethod === "PHONE_PASSCODE" && phone?.phoneCountryCode === "+86"
            ? `+86${phone.phoneNumber}`
            : body?.verifyMethod === "EMAIL_PASSCODE"
              ? email?.email
              : undefined;
        const passCode = phone?.passCode ?? email?.passCode;
        const account = destination ? accountOf(destination) : undefined;
        if (!destination || !passCode || codes.get(`reset_password:${destination}`) !== passCode)
          return refusal(400, "wrong or expired code");
        codes.delete(`reset_password:${destination}`);
        if (!account) return refusal(404, "no such user");
        const passwordResetToken = randomBytes(16).toString("base64url");
        resetTokens.set(passwordResetToken, account.profile.sub);
        return Response.json({
          statusCode: 200,
          message: "ok",
          data: { passwordResetToken, tokenExpiresIn: 300 },
        });
      }
      if (url.pathname === "/api/v3/reset-password" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          passwordResetToken?: string;
          password?: string;
        } | null;
        if (request.headers.get("x-authing-app-id") !== appId) return refusal(401, "invalid app");
        const sub = body?.passwordResetToken ? resetTokens.get(body.passwordResetToken) : undefined;
        if (!body?.passwordResetToken || !sub) return refusal(400, "invalid reset token");
        if (!body.password || body.password.length < 8 || body.password === refusedPassword)
          return refusal(400, "password does not meet the policy");
        resetTokens.delete(body.passwordResetToken);
        passwords.set(sub, body.password);
        resets.push({ sub });
        return Response.json({ statusCode: 200, message: "ok", data: { isSuccess: true } });
      }
      if (url.pathname === "/api/v3/signin" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          connection?: string;
          passwordPayload?: { email?: string; password?: string };
          passCodePayload?: {
            email?: string;
            phone?: string;
            phoneCountryCode?: string;
            passCode?: string;
          };
          options?: { scope?: string; clientIp?: string; autoRegister?: boolean };
          client_id?: string;
          client_secret?: string;
        } | null;
        if (
          request.headers.get("x-authing-app-id") !== appId ||
          body?.client_id !== appId ||
          body?.client_secret !== appSecret ||
          (body?.connection !== "PASSWORD" && body?.connection !== "PASSCODE")
        ) {
          return refusal(401, "invalid client");
        }
        let key: Key | undefined;
        let profile: Person | undefined;
        if (body.connection === "PASSWORD") {
          key = (Object.keys(people) as Key[]).find(
            (candidate) =>
              signInEmailOf(people[candidate]) ===
              body.passwordPayload?.email?.trim().toLowerCase(),
          );
          profile = key
            ? people[key]
            : registered.find(
                (person) =>
                  person.email === body.passwordPayload?.email?.trim().toLowerCase() &&
                  passwords.has(person.sub),
              );
        }
        const signIn: (typeof signIns)[number] = {
          person: key ?? null,
          connection: body.connection,
          ...(body.options?.clientIp ? { clientIp: body.options.clientIp } : {}),
        };
        signIns.push(signIn);
        if (body.connection === "PASSWORD") {
          if (
            !profile ||
            body.passwordPayload?.password !== (passwords.get(profile.sub) ?? personPassword)
          ) {
            return refusal(400, "wrong email or password");
          }
        } else {
          const payload = body.passCodePayload;
          const email = payload?.email;
          const phone = payload?.phone;
          const destination = email ?? `${payload?.phoneCountryCode}${phone}`;
          if (!(email || (phone && payload?.phoneCountryCode === "+86")))
            return refusal(400, "invalid destination");
          if (!payload?.passCode || codes.get(`login:${destination}`) !== payload.passCode)
            return refusal(400, "wrong or expired code");
          codes.delete(`login:${destination}`);
          key = (Object.keys(people) as Key[]).find((candidate) =>
            email ? signInEmailOf(people[candidate]) === email : people[candidate].phone === phone,
          );
          signIn.person = key ?? null;
          profile = key
            ? people[key]
            : registered.find((person) =>
                email ? person.email === email : person.phone === phone,
              );
          if (!profile) {
            if (body.options?.autoRegister !== true) return refusal(404, "no such user");
            profile = { sub: registeredSubFor(destination), ...(email ? { email } : { phone }) };
            registered.push(profile);
          }
        }
        return issueTokens(key, profile, body.options?.scope);
      }
      if (github && url.pathname === "/api/v3/signin-by-mobile" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          connection?: string;
          extIdpConnidentifier?: string;
          githubPayload?: { code?: string };
          options?: { scope?: string };
          client_id?: string;
          client_secret?: string;
        } | null;
        if (
          request.headers.get("x-authing-app-id") !== appId ||
          body?.client_id !== appId ||
          body?.client_secret !== appSecret ||
          body?.connection !== "github" ||
          body?.extIdpConnidentifier !== github.connection
        ) {
          return refusal(401, "invalid client");
        }
        const profile = body.githubPayload?.code
          ? github.consume(body.githubPayload.code)
          : undefined;
        const key = (Object.keys(people) as Key[]).find(
          (candidate) => people[candidate].sub === profile?.sub,
        );
        signIns.push({ person: key ?? null, connection: body.connection });
        if (!profile) return refusal(602, "GitHub did not accept the code");
        if (!key && !registered.some((person) => person.sub === profile.sub)) {
          registered.push(profile);
        }
        return issueTokens(key, profile, body.options?.scope);
      }
      if (url.pathname === "/oidc/me") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const profile = accessTokens.get(token)?.profile;
        return profile && !profile.refused
          ? Response.json(profile)
          : new Response(null, { status: 401 });
      }
      if (url.pathname === "/oidc/token/revocation" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        if (form.get("client_id") !== appId || form.get("client_secret") !== appSecret) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        const token = form.get("token") ?? "";
        revoked.push({ token, person: accessTokens.get(token)?.key ?? undefined });
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  /** Waits until the Web server has revoked `count` tokens, which it does in the background after
   * a sign-in, and returns them; what has arrived by then if they do not all come. */
  async function revocations(count: number) {
    for (let wait = 0; wait < 100 && revoked.length < count; wait++) await Bun.sleep(50);
    return revoked;
  }
  return {
    server,
    issuer: `https://127.0.0.1:${server.port}/oidc`,
    signIns,
    revoked,
    revocations,
    sentCodes,
    registered,
    refusedResetSends,
    resets,
  };
}
