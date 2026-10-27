import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { CODE_SEND_DESTINATION_LIMIT } from "#src/server/auth/sign-in-rate-limits.server";
import {
  codeTab,
  nameField,
  onNameStep,
  onSignInPage,
  openBrowser,
  registeredSubFor,
  removeSignInAccounts,
  requireLocalServices,
  startSignInStack,
  throttledDestination,
  unsendableDestination,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Signing in with a verification code sent to a phone number or an email, end to end. The code
 * tab is the page's first: a code for an email reaches an existing person, a code for a phone
 * number nobody has used makes the account (Authing's `autoRegister`) and lands on the name step;
 * a wrong code, an unusable destination, Authing's own throttle and an outage each say so under
 * the form; a destination is sent at most `CODE_SEND_DESTINATION_LIMIT` codes an hour, however it
 * is spelled, and Authing hears nothing of the sixth; Redis holds only hashes of destinations.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`). It
 * needs `agent-browser`, `openssl`, the local dev database and a local Redis, and deletes what it
 * created. Screenshots and the Web server's log are written under `.amp/e2e/code-sign-in/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-code-sign-in.e2e.ts
 */
const { databaseUrl, redisUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/code-sign-in");

const people = {
  alice: {
    sub: "e2e-code-sign-in-alice",
    email: "e2e-code-alice@coforge.test",
    name: "Code Alice E2E",
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

/** A phone number nobody has used, as Authing receives it and as people type it. */
const newPhone = "+8613800138001";
const newPhoneTyped = "+86 138-0013-8001";
const limitedPhone = "+8613800138002";
const limitedPhoneSpellings = ["13800138002", "+86 138 0013 8002", "138-0013-8002"];

test("signing in with a code sent by SMS or email", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const session = `code-sign-in-${process.pid}`;
  const { browser, evaluate, waitFor, button, requestCode, submitCode, setInput } =
    openBrowser(session);

  const subjects = [
    ...Object.values(people).map((person) => person.sub),
    registeredSubFor(newPhone),
  ];
  const removeSeeded = () => removeSignInAccounts(db, subjects);

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onSignInHere = onSignInPage(origin);
    const onNameStepHere = onNameStep(origin);
    /** The form's inline error, or null. */
    const formError = `(document.querySelector("main form [role=alert]")?.textContent ?? null)`;
    /** What the send button says. */
    const sendButton = `[...document.querySelectorAll("main form button")].find((b) => /^(Send code|Resend in)/.test(b.textContent.trim()))`;
    /** Waits for Authing to have been asked for `count` codes in all. */
    async function waitForSent(count: number) {
      const deadline = Date.now() + 20_000;
      while (fake.sentCodes.length < count) {
        if (Date.now() > deadline) throw new Error(`Authing sent ${fake.sentCodes.length} codes`);
        await Bun.sleep(50);
      }
    }
    async function openSignIn() {
      await browser("open", `${origin}/login`);
      await waitFor(onSignInHere);
    }

    await removeSeeded();
    await browser("set", "viewport", "1440", "900");
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.30" }));
    await mkdir(artifacts, { recursive: true });

    // The code tab comes first, with no password field in sight.
    await openSignIn();
    expect(await evaluate<string>(`${codeTab}.getAttribute("aria-selected")`)).toBe("true");
    expect(await evaluate<boolean>(`!!document.querySelector('main input[name="password"]')`)).toBe(
      false,
    );
    await browser("screenshot", join(artifacts, "1-code-tab.png"));

    // What is typed is checked first: neither a malformed destination nor a malformed code costs
    // Authing a call.
    await requestCode("12345");
    await waitFor(`${formError} === "Enter a mainland China phone number or an email address."`);
    await setInput('main input[name="destination"]', "e2e-code-alice@coforge.test");
    await setInput('main input[name="code"]', "12ab");
    await browser("eval", `${button("Sign In")}.click()`);
    await waitFor(`${formError} === "The verification code is incorrect or expired."`);
    expect(fake.sentCodes).toEqual([]);
    expect(fake.signIns).toEqual([]);
    await browser("screenshot", join(artifacts, "2-malformed.png"));

    // An existing person signs in with a code sent to their email, however it is typed.
    await openSignIn();
    await requestCode(" E2E-Code-Alice@Coforge.test ");
    await waitForSent(1);
    expect(fake.sentCodes[0]).toMatchObject({
      channel: "email",
      destination: "e2e-code-alice@coforge.test",
    });
    // The button counts down before another code can be asked for.
    await waitFor(`/^Resend in \\d+s$/.test(${sendButton}.textContent.trim())`);
    expect(await evaluate<boolean>(`${sendButton}.disabled`)).toBe(true);
    await browser("screenshot", join(artifacts, "3-code-sent.png"));

    // A wrong code says so under the form and signs nobody in; the right one still works after.
    await submitCode("000000");
    await waitFor(`${formError} === "The verification code is incorrect or expired."`);
    expect(await evaluate<boolean>(`location.pathname.endsWith("/login")`)).toBe(true);
    expect(await evaluate<boolean>(`!!document.querySelector("[data-sonner-toast]")`)).toBe(false);
    expect(fake.revoked).toEqual([]);
    await browser("screenshot", join(artifacts, "4-wrong-code.png"));
    await submitCode(fake.sentCodes[0]!.code);
    await waitFor(onNameStepHere);
    expect(await evaluate<string>(`${nameField}.value`)).toBe(people.alice.name);
    // The existing account was signed in; none was made, and Authing's token is gone.
    expect(fake.registered).toEqual([]);
    expect((await fake.revocations(1)).map((entry) => entry.person)).toEqual(["alice"]);
    expect(fake.signIns.at(-1)).toMatchObject({ person: "alice", connection: "PASSCODE" });
    await browser("screenshot", join(artifacts, "5-existing-email.png"));

    // A phone number nobody has used signs up on its first code: the name step starts empty.
    await browser("cookies", "clear");
    await openSignIn();
    await requestCode(newPhoneTyped);
    await waitForSent(2);
    expect(fake.sentCodes[1]).toMatchObject({ channel: "sms", destination: newPhone });
    await submitCode(fake.sentCodes[1]!.code);
    await waitFor(onNameStepHere);
    expect(await evaluate<string>(`${nameField}.value`)).toBe("");
    expect(fake.registered.map((person) => person.sub)).toEqual([registeredSubFor(newPhone)]);
    const identity = await db.userIdentity.findUniqueOrThrow({
      where: {
        provider_providerSubject: {
          provider: "authing",
          providerSubject: registeredSubFor(newPhone),
        },
      },
    });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: identity.userId } })).welcomedAt,
    ).toBeNull();
    expect((await fake.revocations(2)).map((entry) => entry.person)).toEqual(["alice", undefined]);
    await browser("screenshot", join(artifacts, "6-new-phone.png"));

    // Authing's own throttle and an outage each have their say, and neither starts the countdown.
    await browser("cookies", "clear");
    await openSignIn();
    await requestCode(throttledDestination);
    await waitFor(`${formError} === "Too many attempts. Try again in a few minutes."`);
    expect(await evaluate<string>(`${sendButton}.textContent.trim()`)).toBe("Send code");
    await requestCode(unsendableDestination);
    await waitFor(`${formError} === "Could not send the code. Try again."`);
    expect(await evaluate<boolean>(`${sendButton}.disabled`)).toBe(false);
    expect(fake.sentCodes).toHaveLength(2);
    await browser("screenshot", join(artifacts, "7-send-failed.png"));

    // A destination is sent CODE_SEND_DESTINATION_LIMIT codes an hour, however it is spelled; the
    // next is refused on the page and Authing is not asked. (The countdown stops a second click on
    // the page, so each ask starts from a fresh load.)
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.31" }));
    const sentBefore = fake.sentCodes.length;
    for (let ask = 0; ask < CODE_SEND_DESTINATION_LIMIT; ask++) {
      await openSignIn();
      await requestCode(limitedPhoneSpellings[ask % limitedPhoneSpellings.length]!);
      await waitForSent(sentBefore + ask + 1);
    }
    expect(fake.sentCodes.slice(sentBefore).map((sent) => sent.destination)).toEqual(
      Array.from({ length: CODE_SEND_DESTINATION_LIMIT }, () => limitedPhone),
    );
    await openSignIn();
    await requestCode("13800138002");
    await waitFor(`${formError} === "Too many attempts. Try again in a few minutes."`);
    expect(fake.sentCodes).toHaveLength(sentBefore + CODE_SEND_DESTINATION_LIMIT);
    expect(await evaluate<string>(`${sendButton}.textContent.trim()`)).toBe("Send code");
    await browser("screenshot", join(artifacts, "8-send-limit.png"));

    // Redis counts a destination by its hash: it never holds a phone number or an email.
    const redis = new RedisClient(redisUrl);
    try {
      const keys = (await redis.send("KEYS", ["coforge:ratelimit:sign-in-*"])) as string[];
      expect(keys.some((key) => key.includes("code"))).toBe(true);
      for (const key of keys) {
        expect(key).not.toContain("1380013");
        expect(key).not.toContain("coforge.test");
      }
    } finally {
      redis.close();
    }
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded();
    await db.$disconnect();
  }
}, 300_000);
