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

const { databaseUrl } = requireLocalServices();
const webPort = Number(Bun.env.COFORGE_E2E_SIGN_IN_WEB_PORT ?? 8798);
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/github-sign-in");

const people = {
  octo: {
    sub: "e2e-github-sign-in-octo",
    email: "e2e-github-octo@coforge.test",
    nickname: "Octo Cat",
  },
} satisfies Record<string, Person>;
type PersonKey = keyof typeof people;
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
    const githubError = `(document.querySelector("main [role=alert]")?.textContent ?? null)`;
    async function openSignIn(path = "/login") {
      await browser("cookies", "clear");
      await browser("open", `${origin}${path}`);
      await waitFor(onSignInHere);
    }
    const pressGitHub = () => browser("eval", `${button(githubButton)}.click()`);
    const returnedToSignIn = (message: string) =>
      `location.pathname.endsWith("/login") && ${githubError} === ${JSON.stringify(message)}`;

    await openSignIn();
    expect(await hasGitHubButton()).toBe(true);
    expect(
      await evaluate<boolean>(
        `${button(githubButton)}.getBoundingClientRect().width >= document.querySelector("main form").getBoundingClientRect().width - 1`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "1-login.png"));

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

    await submitName("Octo Cat");
    await waitFor(`location.pathname.includes("/w/")`);
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: identity.userId },
      include: { workspace: true },
    });
    const returnTo = `/w/${membership.workspace.slug}/projects`;
    await openSignIn(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    await pressGitHub();
    await waitFor(
      `location.origin === ${JSON.stringify(origin)} && location.pathname.endsWith("/projects")`,
    );
    expect(github.authorizations).toHaveLength(2);
    expect(github.authorizations[1]!.state).not.toBe(github.authorizations[0]!.state);
    expect(fake.signIns.map((entry) => entry.person)).toEqual(["octo", "octo"]);
    expect(fake.registered).toEqual([]);

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

    github.respondWith({ kind: "approve", person: fresh });
    await openSignIn();
    await pressGitHub();
    await waitFor(onNameStepHere);
    expect(fake.registered.map((person) => person.sub)).toEqual([fresh.sub]);
    expect(await evaluate<string>(`${nameField}.value`)).toBe("Fresh Octo");

    const signInsBefore = fake.signIns.length;

    github.respondWith({ kind: "approve", person: null });
    await openSignIn();
    await pressGitHub();
    await waitFor(returnedToSignIn("Could not sign in with GitHub. Try again."));
    expect(fake.signIns).toHaveLength(signInsBefore + 1);
    expect(await fake.revocations(signInsBefore)).toHaveLength(signInsBefore);
    expect(await evaluate<boolean>(`!!document.querySelector("[data-toast]")`)).toBe(false);

    await browser("cookies", "clear");
    await browser("open", `${origin}/zh-CN/login`);
    await waitFor(`!!${button("使用 GitHub 账号登录")}`);
  } finally {
    await browser("close").catch(() => undefined);
    await stack?.stop();
    github.server.stop(true);
    await removeSeeded();
    await db.$disconnect();
  }

  const log = await Bun.file(join(artifacts, "web.log")).text();
  expect(log).toContain('"stage":"github_sign_in"');
  for (const code of github.issued) expect(log).not.toContain(code);
}, 300_000);
