import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import {
  onSignInPage,
  openBrowser,
  passwordTab,
  personPassword,
  removeSignInAccounts,
  requireLocalServices,
  signInEmailOf,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Setting a new password from Settings → Account (task #139), end to end: a person whose email the
 * provider verified opens "Set a new password", sees the email the code goes to, asks for a code
 * (which reaches that email, sent by the fake Authing like a password-reset code), types it with a
 * new password and saves; the dialog closes and a "Password updated" toast shows. The password
 * really changed: the fake Authing recorded the reset for this account, the old password no longer
 * signs in and the new one does.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`). It
 * needs `agent-browser`, `openssl`, the local dev database and a local Redis, and deletes what it
 * created. Screenshots and the Web server's log are written under `.artifacts/e2e/account-password/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-account-password.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/account-password");

const people = {
  alice: {
    sub: "e2e-account-password-alice",
    email: "e2e-account-password-alice@coforge.test",
    email_verified: true,
    name: "Account Password Alice E2E",
  },
} satisfies Record<string, Person>;

const slug = "e2e-account-password";
const newPassword = "e2e-account-new-password";

test("a person with a verified email sets a new password from Settings → Account", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<keyof typeof people>>> | undefined;
  const { browser, evaluate, waitFor, button, setInput, submitSignIn } = openBrowser(
    `account-password-${process.pid}`,
  );
  const removeSeeded = () =>
    removeSignInAccounts(
      db,
      Object.values(people).map((person) => person.sub),
    );

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onSignInHere = onSignInPage(origin);
    const dialog = `document.querySelector("[data-account-password-dialog]")`;
    const dialogButton = (pattern: string) =>
      `[...${dialog}.querySelectorAll("button")].find((b) => ${pattern}.test(b.textContent.trim()))`;
    const toastShown = `document.body.innerText.includes("Password updated")`;
    const formError = `(document.querySelector("main form [role=alert]")?.textContent ?? null)`;

    await removeSeeded();
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.50" }));

    // A person with a Workspace and a name, as sign-in would leave them, whose email is verified.
    const user = await db.user.create({
      data: {
        displayName: "Account Password Alice",
        username: "e2e-account-password-alice",
        email: people.alice.email,
        emailVerified: true,
        welcomedAt: new Date(),
      },
    });
    await db.userIdentity.create({
      data: { userId: user.id, provider: "authing", providerSubject: people.alice.sub },
    });
    await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name: "Account Password Team",
      userId: user.id,
    });

    const signIn = async (password: string) => {
      await browser("open", `${origin}/login?returnTo=${encodeURIComponent(`/w/${slug}`)}`);
      await waitFor(onSignInHere);
      await submitSignIn(signInEmailOf(people.alice), password);
    };

    await signIn(personPassword);
    await waitFor(
      `location.origin === ${JSON.stringify(origin)} && location.pathname.includes("/w/${slug}") && document.body.innerText.includes("general")`,
    );

    // Settings → Account: the Password row's button opens the dialog, which names the email.
    await browser("open", `${origin}/en/w/${slug}/settings?section=account`);
    await waitFor(`!!${button("Set a new password")}`);
    await browser("eval", `${button("Set a new password")}.click()`);
    await waitFor(`!!${dialog}`);
    expect(await evaluate<string>(`${dialog}.innerText`)).toContain(people.alice.email);
    await browser("screenshot", join(artifacts, "1-dialog.png"));

    // Send code: the fake Authing is asked for a code to the email, which is where the test reads it.
    const codesTo = () => fake.sentCodes.filter((sent) => sent.destination === people.alice.email);
    await waitFor(`!!${dialogButton("/^Send code$/")}`);
    await browser("eval", `${dialogButton("/^Send code$/")}.click()`);
    const deadline = Date.now() + 20_000;
    while (codesTo().length < 1) {
      if (Date.now() > deadline) throw new Error("Authing was sent no code request");
      await Bun.sleep(50);
    }
    const sent = codesTo()[0]!;
    expect(sent).toMatchObject({ channel: "email", destination: people.alice.email });
    await waitFor(`/^Resend in \\d+s$/.test(${dialogButton("/^Resend in/")}?.textContent.trim())`);

    // The code and a new password; Save is enabled by both and the dialog then closes on a toast.
    await setInput('[data-account-password-dialog] input[name="code"]', sent.code);
    await setInput('[data-account-password-dialog] input[name="password"]', newPassword);
    await waitFor(`${dialogButton("/^Save$/")}.disabled === false`);
    await browser("screenshot", join(artifacts, "2-filled.png"));
    await browser("eval", `${dialogButton("/^Save$/")}.click()`);
    await waitFor(`!${dialog} && ${toastShown}`);
    await browser("screenshot", join(artifacts, "3-updated.png"));

    // The password changed at Authing, for this account; the old one no longer signs in.
    expect(fake.resets).toEqual([{ sub: people.alice.sub }]);
    await browser("cookies", "clear");
    await browser("open", `${origin}/login?returnTo=${encodeURIComponent(`/w/${slug}`)}`);
    await waitFor(onSignInHere);
    await submitSignIn(signInEmailOf(people.alice), personPassword);
    await waitFor(`${formError} === "Account or password is incorrect."`);
    await setInput('main input[name="password"]', newPassword);
    await browser("eval", `${button("Sign in")}.click()`);
    await waitFor(`location.pathname.includes("/w/${slug}") && !${passwordTab}`);
    expect(fake.signIns.at(-1)).toMatchObject({ person: "alice", connection: "PASSWORD" });
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded();
    await db.$disconnect();
  }
}, 180_000);
