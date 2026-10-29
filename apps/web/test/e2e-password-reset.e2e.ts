import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { CODE_SEND_DESTINATION_LIMIT } from "#src/server/auth/sign-in-rate-limits.server";
import {
  codeTab,
  destinationField,
  emailField,
  hydrated,
  nameField,
  onNameStep,
  onSignInPage,
  openBrowser,
  passwordFieldSelector,
  passwordTab,
  personPassword,
  refusedPassword,
  removeSignInAccounts,
  requireLocalServices,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Setting a new password with a code sent to the account's phone number or email, end to end. The
 * password tab's "Forgot password?" opens the reset page (`returnTo` kept, and `prompt=login`, which keeps a signed-in person there and brings them back to a
 * sign-in that still asks); a code for an email
 * sets the password, which then signs in where the old one no longer does, and the page returns
 * to the sign-in with the email filled in and signs nobody in; a wrong code, a password that is
 * too short and a password Authing refuses each say so under the form; a destination no account
 * has gets the very answer a known one does (the code fields and the countdown), and Authing's
 * refusal of it shows nowhere; sending is limited like the code sign-in's, and the reset token
 * never reaches the browser.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`). It
 * needs `agent-browser`, `openssl`, the local dev database and a local Redis, and deletes what it
 * created. Screenshots and the Web server's log are written under `.amp/e2e/password-reset/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-password-reset.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/password-reset");

const people = {
  alice: {
    sub: "e2e-password-reset-alice",
    email: "e2e-reset-alice@coforge.test",
    name: "Reset Alice E2E",
  },
  phoned: {
    sub: "e2e-password-reset-phoned",
    email: "e2e-reset-phoned@coforge.test",
    phone: "13800138011",
    name: "Reset Phoned E2E",
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

const newPassword = "e2e-brand-new-password";
const unknownEmail = "e2e-reset-nobody@coforge.test";
const limitedEmail = "e2e-reset-limited@coforge.test";
const returnTo = "/w/e2e-reset";

test("setting a new password with a code sent by SMS or email", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const session = `password-reset-${process.pid}`;
  const { browser, evaluate, waitFor, button, requestCode, setInput } = openBrowser(session);
  const removeSeeded = () =>
    removeSignInAccounts(
      db,
      Object.values(people).map((person) => person.sub),
    );

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onSignInHere = onSignInPage(origin);
    const onNameStepHere = onNameStep(origin);
    const resetCodeField = `document.querySelector('main input[name="code"]')`;
    const onResetPage = `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith("/login/reset-password") && ${hydrated(destinationField)}`;
    /** The form's inline error, or null. */
    const formError = `(document.querySelector("main form [role=alert]")?.textContent ?? null)`;
    /** The sign-in page's notice, or null. */
    const notice = `(document.querySelector("main [role=status]")?.textContent ?? null)`;
    const sendButton = `[...document.querySelectorAll("main form button")].find((b) => /^(Send code|Resend in)/.test(b.textContent.trim()))`;
    const resetCodes = () => fake.sentCodes.filter((sent) => sent.purpose === "reset_password");
    async function waitForResetCodes(count: number) {
      const deadline = Date.now() + 20_000;
      while (resetCodes().length < count) {
        if (Date.now() > deadline) throw new Error(`Authing sent ${resetCodes().length} codes`);
        await Bun.sleep(50);
      }
    }
    async function openResetPage() {
      await browser(
        "open",
        `${origin}/login/reset-password?returnTo=${encodeURIComponent(returnTo)}`,
      );
      await waitFor(onResetPage);
    }
    /** Types the code and the new password, and presses the page's submit button. */
    async function submitReset(code: string, password: string) {
      await setInput('main input[name="code"]', code);
      await setInput(passwordFieldSelector, password);
      await browser("eval", `${button("Reset password")}.click()`);
    }

    await removeSeeded();
    await browser("set", "viewport", "1440", "900");
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.40" }));
    await mkdir(artifacts, { recursive: true });

    // The password tab has no sign-up of its own: "No account?" switches to the code tab, whose
    // first sign-in creates the account.
    await browser("open", `${origin}/login?returnTo=${encodeURIComponent(returnTo)}`);
    await waitFor(onSignInHere);
    await browser("eval", `${passwordTab}.click()`);
    await waitFor(hydrated(emailField));
    await browser("screenshot", join(artifacts, "0-password-tab.png"));
    await browser("eval", `${button("Create one with a code")}.click()`);
    await waitFor(`!!${destinationField}`);
    expect(await evaluate<string>(`${codeTab}.getAttribute("aria-selected")`)).toBe("true");

    // The password tab's "Forgot password?" opens the reset page, which asks for the destination
    // first: no code or password field yet.
    await browser("eval", `${passwordTab}.click()`);
    await waitFor(hydrated(emailField));
    await browser("eval", `${button("Forgot password?")}.click()`);
    await waitFor(onResetPage);
    expect(await evaluate<boolean>(`!!${resetCodeField}`)).toBe(false);
    expect(await evaluate<string>(`location.search`)).toContain(encodeURIComponent(returnTo));
    await browser("screenshot", join(artifacts, "1-reset-page.png"));

    // An unusable destination is refused before Authing is asked.
    await requestCode("12345");
    await waitFor(`${formError} === "Enter a mainland China phone number or an email address."`);
    expect(fake.sentCodes).toEqual([]);

    // A reset code for an existing email; the code and password fields appear and the button counts
    // down.
    await requestCode(` ${people.alice.email.toUpperCase()} `);
    await waitForResetCodes(1);
    expect(resetCodes()[0]).toMatchObject({ channel: "email", destination: people.alice.email });
    await waitFor(
      `!!${resetCodeField} && /^Resend in \\d+s$/.test(${sendButton}.textContent.trim())`,
    );
    await browser("screenshot", join(artifacts, "2-code-sent.png"));

    // A password too short, a wrong code: each says so and changes nothing; the code still works.
    await submitReset(resetCodes()[0]!.code, "short");
    await waitFor(`${formError} === "Use 8 to 128 characters."`);
    await submitReset("000000", newPassword);
    await waitFor(`${formError} === "The verification code is incorrect or expired."`);
    expect(fake.resets).toEqual([]);
    expect(await evaluate<boolean>(`location.pathname.endsWith("/login/reset-password")`)).toBe(
      true,
    );
    await browser("screenshot", join(artifacts, "3-refused.png"));

    // The right code sets the password, and the page goes back to the sign-in with the email filled
    // in and the password tab up: nobody is signed in, and `returnTo` is kept.
    await submitReset(resetCodes()[0]!.code, newPassword);
    await waitFor(`${onSignInHere} && ${notice} === "Password updated."`);
    expect(fake.resets).toEqual([{ sub: people.alice.sub }]);
    expect(await evaluate<string>(`${passwordTab}.getAttribute("aria-selected")`)).toBe("true");
    expect(await evaluate<string>(`${emailField}.value`)).toBe(people.alice.email);
    expect(await evaluate<string>(`location.search`)).toContain(encodeURIComponent(returnTo));
    expect(await evaluate<string>(`location.href`)).not.toContain("coforge.test");
    expect(fake.signIns).toEqual([]);
    await browser("screenshot", join(artifacts, "4-password-updated.png"));

    // The old password no longer signs in; the new one does, to the name step of a first sign-in.
    await setInput(passwordFieldSelector, personPassword);
    await browser("eval", `${button("Sign In")}.click()`);
    await waitFor(`${formError} === "Email or password is incorrect."`);
    await setInput(passwordFieldSelector, newPassword);
    await browser("eval", `${button("Sign In")}.click()`);
    await waitFor(onNameStepHere);
    expect(await evaluate<string>(`${nameField}.value`)).toBe(people.alice.name);
    expect(fake.signIns.at(-1)).toMatchObject({ person: "alice", connection: "PASSWORD" });

    // Alice is signed in, and Login with CoForge asks her to sign in again (`prompt=login`); she has
    // forgotten the password. The reset page is hers to use, not a bounce on to `returnTo`, and
    // the sign-in she comes back to after the reset is still asking.
    const stillAsking = (search: string) => {
      expect(search).toContain("prompt=login");
      expect(search).toContain(encodeURIComponent(returnTo));
    };
    await browser("open", `${origin}/login?prompt=login&returnTo=${encodeURIComponent(returnTo)}`);
    await waitFor(onSignInHere);
    await browser("eval", `${passwordTab}.click()`);
    await waitFor(hydrated(emailField));
    await browser("eval", `${button("Forgot password?")}.click()`);
    await waitFor(onResetPage);
    stillAsking(await evaluate<string>(`location.search`));
    await requestCode(people.alice.email);
    await waitForResetCodes(2);
    await waitFor(`!!${resetCodeField}`);
    await submitReset(resetCodes()[1]!.code, newPassword);
    await waitFor(`${onSignInHere} && ${notice} === "Password updated."`);
    stillAsking(await evaluate<string>(`location.search`));
    expect(fake.resets).toEqual([{ sub: people.alice.sub }, { sub: people.alice.sub }]);
    await browser("screenshot", join(artifacts, "4b-prompt-login-reset.png"));
    await browser("cookies", "clear");

    // Authing refusing the new password is shown as such, and the browser is told nothing more.
    await openResetPage();
    await requestCode(people.phoned.phone);
    await waitForResetCodes(3);
    expect(resetCodes()[2]).toMatchObject({
      channel: "sms",
      destination: `+86${people.phoned.phone}`,
    });
    await waitFor(`!!${resetCodeField}`);
    await submitReset(resetCodes()[2]!.code, refusedPassword);
    await waitFor(`${formError} === "This password can't be used. Choose another."`);
    expect(fake.resets).toHaveLength(2);

    // By SMS it works too; a phone number has no password sign-in, so the code tab is where it goes.
    await openResetPage();
    await requestCode("+86 138-0013-8011");
    await waitForResetCodes(4);
    await waitFor(`!!${resetCodeField}`);
    await submitReset(resetCodes()[3]!.code, newPassword);
    await waitFor(
      `${onSignInHere} && ${notice} === "Password updated. Phone numbers sign in with a code."`,
    );
    expect(fake.resets.at(-1)).toEqual({ sub: people.phoned.sub });
    expect(await evaluate<string>(`${codeTab}.getAttribute("aria-selected")`)).toBe("true");
    expect(await evaluate<string>(`${destinationField}.value`)).toBe(people.phoned.phone);
    await browser("screenshot", join(artifacts, "5-phone-updated.png"));

    // An email no account has gets the same answer: the code fields, the countdown, no message.
    // Authing refused it and sent nothing, and a code typed anyway is simply wrong.
    await openResetPage();
    await requestCode(unknownEmail);
    await waitFor(
      `!!${resetCodeField} && /^Resend in \\d+s$/.test(${sendButton}.textContent.trim())`,
    );
    expect(await evaluate<string | null>(formError)).toBeNull();
    expect(fake.refusedResetSends).toEqual([{ channel: "email", destination: unknownEmail }]);
    expect(resetCodes()).toHaveLength(4);
    await submitReset("123456", newPassword);
    await waitFor(`${formError} === "The verification code is incorrect or expired."`);
    expect(fake.resets).toHaveLength(3);
    await browser("screenshot", join(artifacts, "6-unknown-destination.png"));

    // Sending is limited per destination like the code sign-in's, known or not: the next is refused
    // on the page and Authing hears nothing of it.
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.41" }));
    for (let ask = 0; ask < CODE_SEND_DESTINATION_LIMIT; ask++) {
      await openResetPage();
      await requestCode(limitedEmail);
      await waitFor(`!!${resetCodeField}`);
    }
    expect(fake.refusedResetSends.filter((sent) => sent.destination === limitedEmail)).toHaveLength(
      CODE_SEND_DESTINATION_LIMIT,
    );
    await openResetPage();
    await requestCode(limitedEmail);
    await waitFor(`${formError} === "Too many attempts. Try again in a few minutes."`);
    expect(fake.refusedResetSends.filter((sent) => sent.destination === limitedEmail)).toHaveLength(
      CODE_SEND_DESTINATION_LIMIT,
    );
    expect(await evaluate<string>(`${sendButton}.textContent.trim()`)).toBe("Send code");
    expect(await evaluate<boolean>(`!!${resetCodeField}`)).toBe(false);
    await browser("screenshot", join(artifacts, "7-send-limit.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded();
    await db.$disconnect();
  }
}, 300_000);
