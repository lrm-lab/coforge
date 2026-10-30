import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";
import {
  hydrated,
  nameField,
  onNameStep,
  onSignInPage,
  openBrowser,
  personPassword,
  removeSignInAccounts,
  requireLocalServices,
  seededUuid,
  signInEmailOf,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Signing in with an email or username and a password on CoForge's own page, end to end, from a
 * Workspace invite link. A signed-out visitor signs in, gives the display name a first sign-in
 * asks for, and comes back to the link to join; a wrong password says so under the form, stays on
 * the page and keeps the link; a username signs in like an email; a sign-in Authing accepts but
 * the profile read refuses says it failed; "Use another account" and "Sign Out" end the session,
 * revoke Authing's token and land on the sign-in page; an account with no email address (a
 * phone-number sign-up) signs in like any other; the hosted sign-in and its callback are gone; the
 * client address the proxy reports reaches Authing, and repeated wrong passwords never lock an
 * account out.
 *
 * Opt-in like the other browser E2Es, but it brings its own servers (`e2e-sign-in-harness.ts`): a
 * stand-in for Authing's v3 sign-in API and a Web dev server with real sign-in pointed at it. It
 * needs `agent-browser`, `openssl`, the local dev database and a local Redis, and deletes what it
 * created. Screenshots and the Web server's log are written under `.amp/e2e/sign-in-flow/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-sign-in-flow.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sign-in-flow");

const people = {
  alice: { sub: "e2e-sign-in-alice", email: "e2e-alice@coforge.test", name: "Alice E2E" },
  // Signs in with the username of an account made by username, not its email.
  bob: {
    sub: "e2e-sign-in-bob",
    email: "e2e-bob@coforge.test",
    username: "e2e-bob",
    name: "Bob E2E",
  },
  // A phone-number sign-up: Authing reports no email.
  "phone-only": {
    sub: "e2e-sign-in-phone-only",
    signInEmail: "e2e-phone-only@coforge.test",
    name: "Phone Only E2E",
  },
  // Authing accepts this account's password but refuses its userinfo request, so its sign-in
  // cannot finish.
  refused: {
    sub: "e2e-sign-in-refused",
    signInEmail: "e2e-refused@coforge.test",
    name: "Refused E2E",
    refused: true,
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;

test("signing in with an email and password, from a Workspace invite link", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const session = `sign-in-flow-${process.pid}`;
  const { browser, evaluate, waitFor, button, submitName, submitSignIn } = openBrowser(session);

  const ownerId = seededUuid("e2e-sign-in-flow:owner");
  const slug = "e2e-sign-in-flow";
  const name = "Sign-in Flow Team";
  const subjects = Object.values(people).map((person) => person.sub);
  /** Removes the test accounts, the Workspaces their first sign-in made, and the invited one. */
  const removeSeeded = () => removeSignInAccounts(db, subjects, [ownerId]);
  const userIdOf = async (person: PersonKey) =>
    (
      await db.userIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: { provider: "authing", providerSubject: people[person].sub },
        },
      })
    ).userId;

  try {
    stack = await startSignInStack({ people, webPort, artifacts });
    const { origin, fake } = stack;
    const onSignInHere = onSignInPage(origin);
    const onNameStepHere = onNameStep(origin);
    /** The first-sign-in name step: what it starts with, then the answer. */
    async function answerNameStep(displayName: string, prefilledWith: string) {
      await waitFor(onNameStepHere);
      expect(await evaluate<string>(`${nameField}.value`)).toBe(prefilledWith);
      await submitName(displayName);
    }
    /** The sign-in form's inline error, or null. */
    const formError = `(document.querySelector("main form [role=alert]")?.textContent ?? null)`;
    /** Opens the sign-in page for the invite link and signs in as `person`. */
    async function signInAs(person: PersonKey, password = personPassword) {
      await browser("open", `${origin}/login?returnTo=${encodeURIComponent(joinPath)}`);
      await waitFor(onSignInHere);
      await submitSignIn(signInEmailOf(people[person]), password);
    }

    // A leftover from an interrupted run starts over.
    await removeSeeded();
    await db.user.upsert({
      where: { id: ownerId },
      create: {
        id: ownerId,
        username: "e2e-sign-in-owner",
        displayName: "Sign-in Owner",
      },
      update: {},
    });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug,
      name,
      userId: ownerId,
    });
    const link = await workspaceJoinLinks(db).create({
      workspaceId: workspace.id,
      actorUserId: ownerId,
      maxUses: null,
      expiresAt: null,
    });
    const joinPath = `/join/${link.token}`;
    /** The invite page, signed in and naming the account `account` (its email, or its name). */
    const onJoinPageAs = (account: string) =>
      `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith(${JSON.stringify(joinPath)}) && document.querySelector("main")?.innerText.includes(${JSON.stringify(`Signed in as ${account}`)})`;

    // The hosted sign-in is gone: nothing answers at its start or its callback.
    for (const path of ["/auth/login", "/auth/callback?code=c&state=s"]) {
      expect((await fetch(`${origin}${path}`, { redirect: "follow" })).status).toBe(404);
    }

    await browser("set", "viewport", "1440", "900");
    // The Web server sits behind a proxy in production, which appends the client's address; here
    // the browser plays the proxy.
    const clientIp = "198.51.100.23";
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": clientIp }));
    await mkdir(artifacts, { recursive: true });

    // Signed out, the invite link offers to sign in, and signing in comes back to it to join.
    await browser("open", `${origin}/en${joinPath}`);
    await waitFor(hydrated(button("Sign In to Join")));
    await browser("screenshot", join(artifacts, "1-signed-out-invite.png"));
    await browser("eval", `${button("Sign In to Join")}.click()`);
    await waitFor(onSignInHere);
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("returnTo")`)).toBe(
      joinPath,
    );
    expect(await evaluate<string>(`document.querySelector("main h1")?.textContent`)).toBe(
      "Sign in to CoForge",
    );
    await browser("screenshot", join(artifacts, "1b-sign-in-page.png"));

    // A wrong password says so under the form, stays on the page with the link, and signs nobody in.
    await submitSignIn(people.alice.email, "not-the-password");
    await waitFor(`${formError} === "Account or password is incorrect."`);
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("returnTo")`)).toBe(
      joinPath,
    );
    expect(await evaluate<boolean>(`!!document.querySelector("[data-sonner-toast]")`)).toBe(false);
    expect(await evaluate<boolean>(`location.pathname.endsWith("/login")`)).toBe(true);
    await browser("screenshot", join(artifacts, "1c-wrong-password.png"));
    expect(fake.signIns.at(-1)?.person).toBe("alice");
    // Authing is told the person's address, not the Web server's.
    expect(fake.signIns.at(-1)?.clientIp).toBe(clientIp);
    expect(fake.revoked).toEqual([]);

    // The right password goes on: a first sign-in is asked for a display name, starting from the
    // provider's own.
    await submitSignIn(people.alice.email, personPassword);
    await waitFor(onNameStepHere);
    await browser("screenshot", join(artifacts, "1d-name-step.png"));
    // Authing's token was revoked as soon as her profile was read: the session holds none.
    expect((await fake.revocations(1)).map((entry) => entry.person)).toEqual(["alice"]);
    // Signed in, but nothing is made for her until she answers.
    const aliceId = await userIdOf("alice");
    expect(await db.workspaceMembership.count({ where: { userId: aliceId } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: aliceId } })).welcomedAt).toBeNull();
    await answerNameStep("Alice E2E", people.alice.name);
    await waitFor(onJoinPageAs(people.alice.email));
    await waitFor(hydrated(button(`Join ${name}`)));
    await browser("screenshot", join(artifacts, "2-back-on-invite-as-alice.png"));
    await browser("eval", `${button(`Join ${name}`)}.click()`);
    // The URL changes before the Workspace renders, so wait for its #general and no error page.
    await waitFor(
      `location.pathname.includes("/w/${slug}") && !${button(`Join ${name}`)} && document.body.innerText.includes("#general") && !document.body.innerText.includes("could not be loaded")`,
    );
    const alice = aliceId;
    expect(
      (
        await db.workspaceMembership.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: alice } },
        })
      ).role,
    ).toBe("member");
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
    });
    expect(
      await db.conversationMember.count({
        where: { conversationId: general.id, userId: alice, leftAt: null },
      }),
    ).toBe(1);
    // Signing up from the invite joined that Workspace and made none of her own.
    expect(await db.workspaceMembership.count({ where: { userId: alice, role: "owner" } })).toBe(0);
    await browser("screenshot", join(artifacts, "3-joined-as-alice.png"));

    // A signed-in person who opens the sign-in page goes straight on to the link.
    await browser("open", `${origin}/login?returnTo=${encodeURIComponent(joinPath)}`);
    await waitFor(onJoinPageAs(people.alice.email));

    // "Use another account" signs out and comes back to sign-in for the same link; the other
    // account has not joined yet.
    await browser("open", `${origin}/en${joinPath}`);
    await waitFor(hydrated(button("Use Another Account")));
    expect(await evaluate<boolean>(`!!${button(`Open ${name}`)}`)).toBe(true);
    await browser("eval", `${button("Use Another Account")}.click()`);
    await waitFor(onSignInHere);
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("returnTo")`)).toBe(
      joinPath,
    );
    await submitSignIn(people.bob.username, personPassword);
    await waitFor(onNameStepHere);
    await answerNameStep("Bob E2E", people.bob.name);
    await waitFor(onJoinPageAs(people.bob.email));
    expect(await evaluate<boolean>(`!!${button(`Join ${name}`)}`)).toBe(true);
    await browser("screenshot", join(artifacts, "4-switched-to-bob.png"));

    // Signing out of a Workspace page lands on the sign-in page and ends the session.
    await browser("cookies", "clear");
    await signInAs("alice");
    await waitFor(onJoinPageAs(people.alice.email));
    await browser("open", `${origin}/en/w/${slug}`);
    await waitFor(`document.body.innerText.includes("#general")`);
    await browser("eval", `document.querySelector('button[aria-label^="Current user"]').click()`);
    await waitFor(
      `[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent.trim() === "Sign Out")`,
    );
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim() === "Sign Out").click()`,
    );
    await waitFor(onSignInHere);
    expect(
      await evaluate<string | null>(`new URL(location.href).searchParams.get("returnTo")`),
    ).toBe(null);
    // Every sign-in's token was revoked at sign-in, each once; signing out had none to revoke.
    const revoked = await fake.revocations(3);
    expect(revoked.map((entry) => entry.person)).toEqual(["alice", "bob", "alice"]);
    expect(new Set(revoked.map((entry) => entry.token)).size).toBe(3);
    await browser("open", `${origin}/en/w/${slug}`);
    await waitFor(onSignInHere);
    await browser("screenshot", join(artifacts, "5-signed-out.png"));

    // An account Authing accepts but whose profile it refuses says sign-in failed, under the form.
    await signInAs("refused");
    await waitFor(`${formError} === "Sign-in failed. Try again."`);
    expect(await evaluate<string>(`new URL(location.href).searchParams.get("returnTo")`)).toBe(
      joinPath,
    );
    await browser("screenshot", join(artifacts, "6-sign-in-failed.png"));

    // An account with no email is signed in, not signed out: after the name step the invite offers
    // to join it, and names the account by the name it gave, never by an @username.
    await signInAs("phone-only");
    await answerNameStep("Phone Only E2E", people["phone-only"].name);
    await waitFor(onJoinPageAs("Phone Only E2E"));
    expect(await evaluate<boolean>(`!!${button(`Join ${name}`)}`)).toBe(true);
    expect(await evaluate<boolean>(`!!${button("Sign In to Join")}`)).toBe(false);
    expect(await evaluate<boolean>(`document.body.innerText.includes("@")`)).toBe(false);
    const phoneUser = await db.user.findUniqueOrThrow({
      where: { id: await userIdOf("phone-only") },
    });
    // With no email or preferred_username the profile name names the account, never a phone number.
    expect(phoneUser.username).toMatch(/^phone-only-e2e(-\d+)?$/);
    await browser("screenshot", join(artifacts, "7-signed-in-without-email.png"));

    // Signing in has no attempt limit (f4afc04b5): wrong passwords past what the removed limit
    // allowed (ten on one account from one address) each still reach Authing, and the right one
    // then signs in, whatever the account's letter case or padding.
    await browser("cookies", "clear");
    await browser("set", "headers", JSON.stringify({ "X-Forwarded-For": "198.51.100.24" }));
    await browser("open", `${origin}/login`);
    await waitFor(onSignInHere);
    const attemptsBefore = fake.signIns.length;
    for (let attempt = 1; attempt <= 11; attempt++) {
      await submitSignIn(
        attempt % 2 ? " E2E-Alice@Coforge.test " : "e2e-alice@coforge.test",
        "not-the-password",
      );
      while (fake.signIns.length < attemptsBefore + attempt) await Bun.sleep(50);
      await waitFor(
        `${formError} === "Account or password is incorrect." && !document.querySelector("main form button[data-loading]")`,
      );
    }
    await submitSignIn(people.alice.email, personPassword);
    await waitFor(`!location.pathname.endsWith("/login")`);
    expect(fake.signIns.length).toBe(attemptsBefore + 12);
    expect(fake.signIns.at(-1)?.clientIp).toBe("198.51.100.24");
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    await removeSeeded();
    await db.$disconnect();
  }
}, 240_000);
