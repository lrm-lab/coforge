import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { githubClientId, githubConnection, startFakeGithub } from "./e2e-fake-github";
import {
  nameField,
  onNameStep,
  onSignInPage,
  openBrowser,
  removeSignInAccounts,
  requireLocalServices,
  startSignInStack,
  type Person,
} from "./e2e-sign-in-harness";

/**
 * Signing in with GitHub on CoForge's own page, end to end. The browser goes to GitHub's authorize
 * page with CoForge's redirect URI and comes back with a code, which the Web server has Authing
 * exchange (`signin-by-mobile`); the person is then signed in like any other. A new person is
 * asked for a name, a returning one goes to the page they came for; a state that does not match
 * the browser's, a refusal on GitHub's page and a code Authing cannot exchange each send the
 * person back to the sign-in page with a message, and Authing hears nothing of the first two. A
 * deployment without GitHub sign-in shows no button and answers the routes with 404.
 *
 * Opt-in like the other browser E2Es, and brings its own servers (`e2e-sign-in-harness.ts`,
 * `e2e-fake-github.ts`). It needs `agent-browser`, `openssl`, the local dev database and a local
 * Redis, and deletes what it created. Screenshots and the Web server's log are written under
 * `.amp/e2e/github-sign-in/`.
 *
 *   REDIS_URL=redis://127.0.0.1:6380 bun test ./test/e2e-github-sign-in.e2e.ts
 */
const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/github-sign-in");

const people = {
  octo: {
    sub: "e2e-github-sign-in-octo",
    email: "e2e-github-octo@coforge.test",
    nickname: "Octo Cat",
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;
/** A GitHub account Authing has not seen: its first sign-in makes the person. */
const fresh: Person = { sub: "e2e-github-sign-in-fresh", nickname: "Fresh Octo" };

const githubButton = "Continue with GitHub";

test("signing in with GitHub", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const github = startFakeGithub();
  let stack: Awaited<ReturnType<typeof startSignInStack<PersonKey>>> | undefined;
  const { browser, evaluate, waitFor, button, submitName } = openBrowser(
    `github-sign-in-${process.pid}`,
  );
  const subjects = [people.octo.sub, fresh.sub];
  const removeSeeded = () => removeSignInAccounts(db, subjects);
  const hasGitHubButton = () => evaluate<boolean>(`!!${button(githubButton)}`);

  try {
    await removeSeeded();
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // A deployment without GitHub sign-in: no button, and the routes are not there.
    stack = await startSignInStack({
      people,
      webPort,
      artifacts,
      env: { COFORGE_GITHUB_SIGN_IN_CLIENT_ID: "", AUTHING_GITHUB_CONNECTION: "" },
    });
    await browser("open", `${stack.origin}/login`);
    await waitFor(onSignInPage(stack.origin));
    expect(await hasGitHubButton()).toBe(false);
    expect((await fetch(`${stack.origin}/auth/github`)).status).toBe(404);
    expect((await fetch(`${stack.origin}/auth/github/callback?code=x&state=y`)).status).toBe(404);
    await stack.stop();
    stack = undefined;

    stack = await startSignInStack({
      people,
      webPort,
      artifacts,
      github: { connection: githubConnection, consume: github.consume },
      env: {
        COFORGE_GITHUB_SIGN_IN_CLIENT_ID: githubClientId,
        AUTHING_GITHUB_CONNECTION: githubConnection,
        COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL: github.authorizeUrl,
      },
    });
    const { origin, fake } = stack;
    const onSignInHere = onSignInPage(origin);
    const onNameStepHere = onNameStep(origin);
    /** The sign-in page's message about GitHub, or null. */
    const githubError = `(document.querySelector("main [role=alert]")?.textContent ?? null)`;
    async function openSignIn(path = "/login") {
      await browser("cookies", "clear");
      await browser("open", `${origin}${path}`);
      await waitFor(onSignInHere);
    }
    const pressGitHub = () => browser("eval", `${button(githubButton)}.click()`);
    const returnedToSignIn = (message: string) =>
      `location.pathname.endsWith("/login") && ${githubError} === ${JSON.stringify(message)}`;

    // The button is below both tabs' forms, full width.
    await openSignIn();
    expect(await hasGitHubButton()).toBe(true);
    expect(
      await evaluate<boolean>(
        `${button(githubButton)}.getBoundingClientRect().width >= document.querySelector("main form").getBoundingClientRect().width - 1`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "1-login.png"));

    // A new person: sent to GitHub with CoForge's redirect URI, back with a code, to the name step.
    github.respondWith({ kind: "approve", person: people.octo });
    await pressGitHub();
    await waitFor(onNameStepHere);
    expect(github.authorizations).toHaveLength(1);
    expect(github.authorizations[0]).toMatchObject({
      clientId: githubClientId,
      redirectUri: `${origin}/auth/github/callback`,
      scope: "read:user user:email",
    });
    expect(github.authorizations[0]!.state!.length).toBeGreaterThanOrEqual(32);
    expect(fake.signIns).toEqual([{ person: "octo", connection: "github" }]);
    expect((await fake.revocations(1)).map((entry) => entry.person)).toEqual(["octo"]);
    expect(await evaluate<string>(`${nameField}.value`)).toBe("Octo Cat");
    const identity = await db.userIdentity.findUniqueOrThrow({
      where: {
        provider_providerSubject: { provider: "authing", providerSubject: people.octo.sub },
      },
    });
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: identity.userId } })).welcomedAt,
    ).toBeNull();
    await browser("screenshot", join(artifacts, "2-name-step.png"));

    // Answering the name step makes the personal Workspace; the same person signing in with GitHub
    // again goes straight to the page they came for.
    await submitName("Octo Cat");
    await waitFor(`location.pathname.includes("/w/")`);
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: identity.userId },
      include: { workspace: true },
    });
    const returnTo = `/w/${membership.workspace.slug}/tasks`;
    await openSignIn(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    await pressGitHub();
    await waitFor(
      `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith("/tasks")`,
    );
    expect(github.authorizations).toHaveLength(2);
    expect(github.authorizations[1]!.state).not.toBe(github.authorizations[0]!.state);
    expect(fake.signIns.map((entry) => entry.person)).toEqual(["octo", "octo"]);
    expect(fake.registered).toEqual([]);

    // Login with CoForge asking a signed-in person to sign in again (`prompt=login`) must not lose
    // that on the way out to GitHub: refusing there comes back to a sign-in page that is still
    // asking, not on to the page they were going to.
    github.respondWith({ kind: "deny" });
    await browser("open", `${origin}/login?prompt=login&returnTo=${encodeURIComponent(returnTo)}`);
    await waitFor(onSignInHere);
    await pressGitHub();
    await waitFor(returnedToSignIn("GitHub sign-in was cancelled."));
    expect(await evaluate<string | null>(`new URL(location.href).searchParams.get("prompt")`)).toBe(
      "login",
    );
    expect(
      await evaluate<string | null>(`new URL(location.href).searchParams.get("returnTo")`),
    ).toBe(returnTo);
    await browser("screenshot", join(artifacts, "2b-prompt-login-denied.png"));

    // A GitHub account Authing has not seen is made on its first sign-in, and is a new person.
    github.respondWith({ kind: "approve", person: fresh });
    await openSignIn();
    await pressGitHub();
    await waitFor(onNameStepHere);
    expect(fake.registered.map((person) => person.sub)).toEqual([fresh.sub]);
    expect(await evaluate<string>(`${nameField}.value`)).toBe("Fresh Octo");

    // A state other than the browser's, or none, is refused before Authing is asked anything.
    const signInsBefore = fake.signIns.length;
    for (const state of ["tampered-state", null]) {
      github.respondWith({ kind: "approve", person: people.octo, state });
      await openSignIn(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      await pressGitHub();
      await waitFor(returnedToSignIn("Could not sign in with GitHub. Try again."));
      expect(
        await evaluate<string | null>(`new URL(location.href).searchParams.get("returnTo")`),
      ).toBe(returnTo);
    }
    await browser("screenshot", join(artifacts, "3-state-mismatch.png"));
    expect(fake.signIns).toHaveLength(signInsBefore);

    // A callback with no start (no cookie of ours) is refused the same way.
    await browser("cookies", "clear");
    await browser("open", `${origin}/auth/github/callback?code=abc&state=abc`);
    await waitFor(returnedToSignIn("Could not sign in with GitHub. Try again."));
    expect(fake.signIns).toHaveLength(signInsBefore);

    // Refusing on GitHub's page says so, and Authing is not asked.
    github.respondWith({ kind: "deny" });
    await openSignIn();
    await pressGitHub();
    await waitFor(returnedToSignIn("GitHub sign-in was cancelled."));
    expect(fake.signIns).toHaveLength(signInsBefore);
    await browser("screenshot", join(artifacts, "4-denied.png"));

    // A code Authing cannot exchange is a failure, with no one signed in.
    github.respondWith({ kind: "approve", person: null });
    await openSignIn();
    await pressGitHub();
    await waitFor(returnedToSignIn("Could not sign in with GitHub. Try again."));
    expect(fake.signIns).toHaveLength(signInsBefore + 1);
    expect(await fake.revocations(signInsBefore)).toHaveLength(signInsBefore);
    expect(await evaluate<boolean>(`!!document.querySelector("[data-sonner-toast]")`)).toBe(false);

    // The page and its button read in Simplified Chinese too.
    await browser("cookies", "clear");
    await browser("open", `${origin}/zh-CN/login`);
    await waitFor(`!!${button("使用 GitHub 登录")}`);
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    github.server.stop(true);
    await removeSeeded();
    await db.$disconnect();
  }

  // The log names the step that failed and holds neither the code nor a token.
  const log = await Bun.file(join(artifacts, "web.log")).text();
  expect(log).toContain('"stage":"github_sign_in"');
  for (const code of github.issued) expect(log).not.toContain(code);
}, 300_000);
